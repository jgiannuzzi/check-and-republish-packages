const core = require('@actions/core');
const github = require('@actions/github');
const {graphql} = require('@octokit/graphql');
const fs = require('fs').promises;
const util = require('util');
const exec = util.promisify(require('child_process').exec);

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function setUpNuget(thisOwner, packagePushToken) {
    await fs.writeFile('nuget.config', `<?xml version="1.0" encoding="utf-8"?>
<configuration>
    <packageSources>
        <clear />
        <add key="github" value="https://nuget.pkg.github.com/${thisOwner}/index.json" />
    </packageSources>
    <packageSourceCredentials>
        <github>
            <add key="Username" value="${thisOwner}" />
            <add key="ClearTextPassword" value="${packagePushToken}" />
        </github>
    </packageSourceCredentials>
</configuration>`);
}

async function getExistingPackages(thisOwner, thisRepo, packagePushToken) {
    const packagesQuery = `
    {
      repository(owner: "${thisOwner}", name: "${thisRepo}") {
        packages(first: 100) {
          nodes {
            name,
            packageType,
            versions(last: 100) {
              nodes {
                version
              }
            }
          }
        }
      }
    }`
    const {repository: {packages: {nodes: packageNodes}} } = await graphql(packagesQuery, {headers: {authorization: 'token ' + packagePushToken}});
    var existingPackages = [];
    for (packageNode of packageNodes) {
        for (versionNode of packageNode.versions.nodes) {
            if (packageNode.packageType == 'NUGET') {
                existingPackages.push(packageNode.name + '.' + versionNode.version + '.nupkg');
            }
        }
    }
    return existingPackages;
}

async function uploadNugetPackage(thisOwner, thisRepo, packageName) {
    console.log('- Unpacking NuGet package');
    await exec('unzip ' + packageName + ' -d extracted_nupkg');

    const filesInPackage = await fs.readdir('extracted_nupkg');
    const nuspecFilename = filesInPackage.find(filename => filename.endsWith('nuspec'));
    if (!nuspecFilename) {
        core.setFailed('Couldn\'t find .nuspec file in NuGet package');
        return;
    }
    
    console.log('- Updating ' + nuspecFilename + ' to reference this repository (required for GitHub package upload to succeed)');
    await exec('chmod 700 extracted_nupkg/' + nuspecFilename);
    const lines = (await fs.readFile('extracted_nupkg/' + nuspecFilename)).toString('utf-8').split('\n');
    for (let i = 0; i < lines.length; i++) {
        const newLine = lines[i].replace(/repository url="[^"]*"/, 'repository url="https://github.com/' + thisOwner + '/' + thisRepo + '"');
        if (newLine != lines[i]) {
            console.log('- ' + lines[i] + ' -> ' + newLine.trim());
            lines[i] = newLine;
        } else {
            console.log('- ' + lines[i]);
        }
    }
    await fs.writeFile('extracted_nupkg/' + nuspecFilename, lines.join('\n'));
    await exec('zip -j ' + packageName + ' extracted_nupkg/' + nuspecFilename);

    console.log('- Uploading NuGet package to https://github.com/' + thisOwner);
    await exec('dotnet nuget push ' + packageName + ' --source "github"');
    console.log('- Uploaded ' + packageName);
}

(async () => {
    try {
        const sourceOwner = core.getInput('source-owner');
        const sourceRepoWorkflowBranches = core.getInput('source-repo-workflow-branches').split(',').map(b => b.trim());
        const sourceToken = core.getInput('source-token');
        const packagePushToken = core.getInput('package-push-token');
        const thisOwner = process.env['GITHUB_REPOSITORY'].split('/')[0];
        const thisRepo = process.env['GITHUB_REPOSITORY'].split('/')[1];

        const octokit = github.getOctokit(sourceToken);

        await setUpNuget(thisOwner, packagePushToken);

        const existingPackages = await getExistingPackages(thisOwner, thisRepo, packagePushToken);

        var thresholdDate = new Date();
        thresholdDate.setHours(thresholdDate.getHours() - 1);

        for (sourceRepoWorkflowBranch of sourceRepoWorkflowBranches) {
            const parts = sourceRepoWorkflowBranch.split('/');
            if (parts.length != 3) {
                core.setFailed('source-repo-workflow-branches should be a comma-separated list of repo/workflow/branch: Found ' + sourceRepoWorkflowBranch);
                continue;
            }
            const sourceRepo = parts[0];
            const workflowName = parts[1];
            const permittedBranch = parts[2];

            console.log('Looking for workflows named "' + workflowName + '" in ' + sourceOwner + '/' + sourceRepo);
            const {data: {workflows}} = await octokit.actions.listRepoWorkflows({owner: sourceOwner, repo: sourceRepo});
            const workflow = workflows.find(workflow => workflow.name == workflowName);
            if (!workflow) {
                core.setFailed('Failed to find workflow "' + workflowName + '" in ' + sourceOwner + '/' + sourceRepo);
                continue;
            }
            console.log('Found workflow with id ' + workflow.id);

            console.log('Looking for runs of that workflow on branch ' + permittedBranch + ' updated after ' + thresholdDate.toISOString());
            const {data: {workflow_runs: workflowRuns}} = await octokit.actions.listWorkflowRuns({owner: sourceOwner, repo: sourceRepo, workflow_id: workflow.id, branch: permittedBranch});
            const recentWorkflowRuns = workflowRuns.filter(workflowRun => new Date(workflowRun.updated_at).getTime() > thresholdDate.getTime());
            console.log('Found ' + recentWorkflowRuns.length + ' workflow run(s)');

            for (workflowRun of recentWorkflowRuns) {
                console.log('Checking workflow run number ' + workflowRun.run_number + ' (updated at ' + workflowRun.updated_at + ')');
                const {data: {artifacts: artifacts}} = await octokit.actions.listWorkflowRunArtifacts({owner: sourceOwner, repo: sourceRepo, run_id: workflowRun.id});
                const {data: {jobs}} = await octokit.actions.listJobsForWorkflowRun({owner: sourceOwner, repo: sourceRepo, run_id: workflowRun.id});
                for (job of jobs) {
                    if (job.status != 'completed') {
                        console.log(job.name + ': ' + job.status);
                        continue;
                    }
                    
                    const {data: log} = await octokit.actions.downloadJobLogsForWorkflowRun({owner: sourceOwner, repo: sourceRepo, job_id: job.id});
                    const logLines = log.split(/\r?\n/)

                    var packagesPublishedByJob = [];
                    for (logLine of logLines) {
                        const match = logLine.match(/--- Uploaded package ([^ ]+) as a GitHub artifact \(SHA256: ([^ ]+)\) ---/)
                        if (match != null) {
                            const package = {name: match[1], sha: match[2]}
                            if (!packagesPublishedByJob.find(p => p.name == package.name)) {
                                packagesPublishedByJob.push(package);
                            }
                        }
                    }
                    console.log(job.name + ': ' + job.status + ', published ' + packagesPublishedByJob.length + ' package(s):');
                    
                    for (package of packagesPublishedByJob) {
                        if (existingPackages.includes(package.name)) {
                            console.log(package.name + ' [' + package.sha + ']: Already republished');
                            continue;
                        }

                        const artifact = artifacts.find(artifact => artifact.name == package.name);
                        if (!artifact) {
                            core.setFailed(package.name + '[' + package.sha + ']: No artifact with that name uploaded by workflow run');
                            continue;
                        }
                        const {data: artifactBytes} = await octokit.actions.downloadArtifact({owner: sourceOwner, repo: sourceRepo, artifact_id: artifact.id, archive_format: 'zip'});
                        await fs.writeFile(package.name + '.zip', Buffer.from(artifactBytes));
                        await exec('unzip ' + package.name + '.zip');
                        const {stdout} = await exec('sha256sum ' + package.name);
                        const sha256 = stdout.slice(0, 64);
                        if (package.sha != sha256) {
                            core.setFailed(package.name + '[' + package.sha + ']: Found artifact with non-matching SHA256 ' + sha256);
                            continue;
                        }
                        
                        console.log(package.name + ' [' + package.sha + ']: Downloaded artifact, SHA256 matches, republishing:');
                        if (package.name.endsWith('.nupkg')) {
                            await uploadNugetPackage(thisOwner, thisRepo, package.name);
                        } else {
                            core.setFailed('Currently only Nuget packages are supported');
                        }
                    }
                }
            }
        }
    } catch (error) {
        core.setFailed(error.message);
    }
})();
