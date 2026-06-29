# LB-MAP Operations

Internal first-level and admin UI for LB-MAP. The service exposes curated
operations runbooks through an Angular Material UI and NestJS API. It is not a
shell, Makefile, kubectl, OpenTofu, or repository command runner.

## Workspace

- `apps/ops-ui`: Angular Material support UI.
- `apps/ops-api`: NestJS API, action registry, RBAC, Kubernetes/Argo clients.
- `apps/ops-contract`: shared TypeScript contract for actions and run results.

## Safety Boundary

V1 actions are allowlisted in code. First-level support gets diagnostic actions
only. Admin roles get the same diagnostics plus non-prune ArgoCD sync,
guarded stateless rollout restart, and smoke-job trigger.

The tool deliberately excludes delete/down/prune, restore, database mutation,
secret/password print, SOPS/decryption, OpenTofu apply/destroy, SSH/provider
access, arbitrary shell execution, and role/group changes.

## Runtime Contract

The API trusts identity headers from the platform ingress/OIDC layer:

- `X-Forwarded-User`
- `X-Forwarded-Email`
- `X-Forwarded-Groups`

Group-to-role mappings are configured by:

- `OPS_FIRST_LEVEL_GROUPS`
- `OPS_ADMIN_GROUPS`

Local mock identity is disabled unless `OPS_DEV_AUTH_USER` is set and
`NODE_ENV` is not `production`.

Durable action history is the platform log/metrics stack. The API keeps only the
latest in-memory run records for immediate UI feedback.

## Development

```sh
npm ci
npm run lint
npm test
npm run build
```

Local API with mock identity:

```sh
OPS_DEV_AUTH_USER=local-operator \
OPS_DEV_AUTH_GROUPS=lb-map-admin \
npm run serve:api
```

## Image

The GitHub workflow builds and publishes:

- `ghcr.io/robspan/lb-map-operations:edge`
- `ghcr.io/robspan/lb-map-operations:<git-sha>`
