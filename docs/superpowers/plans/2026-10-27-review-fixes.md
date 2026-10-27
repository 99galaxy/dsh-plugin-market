# Review fixes implementation plan

Goal: fix the six confirmed review findings without discarding existing 1.2.0 work.

Approved scope: isolate inventory by profile and validate its owner; preserve disabled bundles except the install target; serialize installs and reloads; separate draft and submitted search; refresh cleared searches; allow checks on a fresh clone without maintainer files.

Implementation uses the existing JavaScript/Node test tools, with no new dependencies.

- [x] Add failing host regressions for profile isolation, bundle activation and reload/install exclusion.
- [x] Make the React harness respect effect dependencies; add search clearing and pagination regressions.
- [x] Add checks for absent optional notes/catalog and malformed inventory ownership.
- [x] Fix host/helper behavior, regenerate the shipped helper, and fix the client search lifecycle.
- [x] Run focused tests, then the full suite and a clean exported checkout with an empty DSH home.
- [x] Review the final diff and report verification and remaining limitations.

Verification: the original regressions failed before their fixes. The full suite ran successfully in the working tree; the final sources also passed all 12 check stages in a clean export, with missing optional local state explicitly skipped. Syntax checks, artifact synchronization and git diff --check passed. Subsequent live desktop verification covered search, pagination, tab counts, profile isolation, installation exclusion, disabled bundles and HMR; temporary test packages were removed. Existing working changes were retained. The subsequent integration request authorizes committing the combined update and pushing main; npm publication is outside this request.
