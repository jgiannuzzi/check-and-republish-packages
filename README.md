# check-and-republish-packages

GitHub action which scans other repos, potentially in other orgs, for workflows which ran [G-Research-Packages/request-republish-package](https://github.com/G-Research-Packages/request-republish-package) on permitted branches. Downloads their artifacts, checks that hashes are as expected and republishes them as GitHub packages.

## Why?

This action (combined with [G-Research-Packages/request-republish-package](https://github.com/G-Research-Packages/request-republish-package) and some carefully crafted permissions)
can be used to ensure that all of the GitHub packages on a GitHub org have been built from protected branches. This is useful where the packages are to be relied upon in a
secure environment. For further details see SDR-816 in G-Research internal JIRA.

## Example usage

See [action.yaml](action.yaml).

```yaml
- uses: G-Research-Packages/check-and-republish-packages@v1
  with:
    source-owner: G-Research-LLE
    source-repo-workflow-branches: example-dotnet-core-classlib/Build and publish NuGet package/master
    source-token: ${{secrets.SOURCE_TOKEN}}
    package-push-token: ${{secrets.PACKAGE_PUSH_TOKEN}}
```

## License

TBC.
