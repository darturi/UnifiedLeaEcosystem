# Stage 8 production qualification and rollback

Qualification is in progress. Final results and immutable artifact references
will be recorded here and in `database-migration-baselines/stage8-release-qualification.json`.
The runtime contract is [STAGE8-process-boundary.md](STAGE8-process-boundary.md).

## Production ownership

Production API, worker and companion images use the actual multi-stage
Dockerfile. The worker contains the pinned compiler, complete Mathlib and
SafeVerify. API and companion containers use read-only roots and have no project
workspace or provider-configuration mount. The serving probes never substitute
application source from the host. Test helpers enter only the private worker.

Workers and the migration job share the Docker **local volume**
`lea-workspace-ownership` at `/app/prover/workspace/.lea-runtime`. Compose retains
the existing data/config/proof/project/import directories and Mathlib volume.
Keep the new ownership volume too; recreating it changes the workspace identity
and the database will refuse that replacement. `LEA_WORKSPACE_OWNERSHIP_VOLUME`
selects a different name for an independent workspace. Every deployment that
shares the same workspace or database must use the same ownership volume.

This volume is required because the measured Docker Desktop host bind mount
accepted two exclusive `flock` calls, including two independent opens within one
container. The same probe on a Docker local volume blocked the second open both
within and across containers. Startup now tests that the lock is enforced before
writing a binding. The production worker profile also requires an actual shared
ownership mount; an unsupported filesystem fails closed.

The database binding records the resolved root and a private persistent volume
identity. Existing version-1 path bindings acquire the version-2 identity under
the exclusive lock. A different root or ownership identity requires an offline
migration. Both bootstrap and worker take workspace ownership, so another DB
cannot migrate or start beneath a live owner of the same tree. Worker ownership
lasts until process exit; bootstrap releases it after its one-shot migration.

Before the first upgrade, stop every old stack that can access these directories.
The old in-process architecture does not implement the new ownership protocol.
Never use volume recreation, database replacement, or a schema downgrade as an
upgrade or rollback mechanism.

## Executable release gate

[The release workflow](../.github/workflows/stage8-release-gates.yml) verifies
host, Docker-daemon and image architectures, then runs on native Ubuntu AMD64 and
ARM64 runners. It installs no emulator. The baseline source is pinned in
[stage8-release-baseline.json](../.github/stage8-release-baseline.json). Each
architecture job:

1. Builds all three baseline production targets and qualifies them before that
   baseline is eligible for rollback.
2. Builds all three successor targets with their packaged source identity and
   qualifies that bundle independently.
3. Runs ownership/recovery/process regressions against the packaged successor
   application code. Only tests and their development dependencies are added to
   that disposable regression container.
4. Rehearses binary rollback against the original database and workspace volumes.
5. Saves both actual image bundles, both source archives, role IDs, runtime
   versions, checksums and the qualification/rehearsal reports as CI artifacts.

[stage8_release.py](../tests/integration/stage8_release.py) upgrades disposable
databases from revisions `0019_custom_tools` and `0031_usage_details`. It checks
historical content retention, rejection of legacy current-proof claims, static
UI delivery, the stateless companion, SQL admission/results, receipt reuse, API
restart, worker crash/expiry/restart, duplicate ownership across distinct DBs,
and queued worker drain while API reads remain available.

Trusted packaging probes compile a small Mathlib proof using the shipped Lean
binary and require SafeVerify to accept that proof and reject its `sorry`
counterpart. Node and Python architectures are measured independently of image
labels. These trusted probes do not enable application execution on an unsupported
platform. Linux still advertises its confined executor as unavailable; there is
no unconfined editor or staged-execution fallback.

Reproduce after building each role, supplying the exact source identity used by
the build:

```sh
python3 tests/integration/stage8_release.py qualify --require-native \
  --source SOURCE_COMMIT --api-image API_IMAGE --worker-image WORKER_IMAGE \
  --companion-image COMPANION_IMAGE --output baseline.json
```

## Rollback rehearsal

The first strict baseline is certified here, rather than selecting a historical
in-process binary. The successor adds packaged build identity to SQL health
reporting. The two bundles contain different API/worker binaries and share schema
`0048_process_boundary` and the same journal/command contracts. This certifies
this exact pair, not arbitrary future downgrades.

The rehearsal first runs the baseline, drains it, and starts the successor on the
same data. The successor persists a completed command receipt, a metadata edit
and an uncertain claimed command. After drain, the private fixture executes the
real file-publication path and interrupts it after SQL intent/history commit,
before materialization. It then starts the exact older strict bundle without
running migration, restoring a backup, or recreating a volume.

The older worker must reconcile the prepared publication, retain both original
and successor history, preserve the completed receipt and its idempotency key,
suspend the uncertain claim, and reject completion by the previous claim owner.
The API must serve those retained SQL results. HTTP build identity and immutable
role IDs verify that the older binaries were actually restored.

```sh
python3 tests/integration/stage8_release.py rollback \
  --baseline baseline.json --candidate candidate.json --output rollback.json
```

Evidence artifacts are retained for 30 days; binary/source archives for 14 days.
Download and retain the qualified bundle before its artifact expiry if it is to
remain an operational rollback target. Verify `SHA256SUMS`, load the saved images,
and use the exact recorded role IDs together. Publication or deployment of those
images is a separate operation. This qualification writes no registry tags and
uses no production database, production workspace, or paid model requests.
