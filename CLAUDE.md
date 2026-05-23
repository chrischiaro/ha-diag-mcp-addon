# ha-diag-mcp-addon — Claude Context

## Releasing a new version

1. Make changes in `ha-diag-mcp/server/src/`
2. Bump version in `ha-diag-mcp/config.yaml`
3. Build: `cd ha-diag-mcp/server && npm run build`
4. Commit and push to main
5. Push a git tag matching the version — this triggers the HA addon update:

```bash
git tag v0.1.XX
git push origin v0.1.XX
```

The tag is what HA uses to detect and offer a new addon version. Pushing commits alone is not enough.
