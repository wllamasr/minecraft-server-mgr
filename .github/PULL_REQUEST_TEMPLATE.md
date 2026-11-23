## Summary

<!-- What does this change and why? Link the issue it resolves: "Closes #123". -->

## Type of change

- [ ] Bug fix
- [ ] New feature
- [ ] Refactor / internal change
- [ ] Documentation
- [ ] Dependency update

## Checklist

- [ ] Commits follow Conventional Commits (`feat(scope): ...`, `fix(scope): ...`).
- [ ] `npm run typecheck`, `npm test` and `npm run build` pass (if the Electron app changed).
- [ ] `go vet ./...` and `go test ./...` pass in `daemon/` (if the daemon changed).
- [ ] New IPC channels are documented in `docs/IPC.md` and exposed only through `src/preload`.
- [ ] Docs (README, `docs/`, user guide) are updated where behavior changed.
- [ ] No secrets, tokens, or personal data are included in the diff or the logs.
- [ ] I have read the [Contributing guide](CONTRIBUTING.md).
