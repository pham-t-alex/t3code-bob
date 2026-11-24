# T3 Code Bob fork

This fork adds IBM Bob provider support to [T3 Code](https://github.com/pingdotgg/t3code). It is not a separate product; keep the diff from upstream small.

## Upstream sync

- `main` is the latest upstream stable tag (`vX.Y.Z`) plus fork changes. Never merge upstream `main` (nightly) and never use GitHub's "Sync fork" button.
- `.github/workflows/sync-upstream-stable.yml` opens a PR from `upstream-sync/<tag>` for each new stable tag. Merge it with a merge commit, not squash or rebase.
- Upstream's own workflows are disabled in this repo's Actions settings; re-enable only what the fork needs.

## Development and builds

- The app targets macOS first, then Windows. Development happens on Windows, so macOS-only behavior (URL scheme routing, Keychain, privacy permissions) needs a Mac to verify, and the `.dmg` must be built on macOS or a macOS CI runner.
- On Windows, three desktop tests fail for host reasons only: two Linux theme-icon tests (case-insensitive filesystem) and `electron-launcher.test.mjs` "restores execute permissions" (POSIX mode bits).
- Builds are unsigned. On macOS that means: Gatekeeper blocks a downloaded build until approved in Privacy & Security; in-app updates do not work (electron-updater requires a matching Developer ID signature), so update by installing the new build; privacy permission grants reset with each new build; T3 Connect passkeys do not work. On Windows, SmartScreen warns on install.
- A Mac that refuses downloaded unsigned apps still runs one built on it. Check out the latest release tag (see **Releases** below) and pass its version: `vp run dist:desktop:dmg --build-version <version>`, for example `0.1.11-bob.3` for tag `v0.1.11-bob.3`. Output goes to `release/`; setup is in [development.md](docs/operations/development.md#desktop-artifacts). Without `--build-version` the app takes the upstream version from `package.json`, so SSH environments find no matching fork server archive and update checks come back on. Building a different commit under a tag's version gives the SSH host that tag's server, not yours.

## Divergences from upstream

Review every sync PR against this list: each item must survive the merge, and conflicts here are expected.

**Install identity.** The fork installs beside stock T3 Code without sharing data.

| Value                                               | Upstream             | Fork                     | Where                                                                                                                                 |
| --------------------------------------------------- | -------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| Data folder                                         | `~/.t3`              | `~/.t3-bob`              | `apps/desktop/src/app/DesktopStatePaths.ts`, `DEFAULT_HOME_DIR_NAME` in `apps/server/src/os-jank.ts` (server and CLI)                 |
| Electron profile                                    | `t3code-v2`          | `t3code-bob`             | `apps/desktop/src/app/DesktopUserData.ts`                                                                                             |
| App ID                                              | `com.t3tools.t3code` | `com.t3tools.t3code.bob` | `scripts/build-desktop-artifact.ts`, `apps/desktop/src/app/DesktopEnvironment.ts`, `apps/desktop/scripts/electron-launcher.mjs`       |
| Product name                                        | `T3 Code (Beta)`     | `T3 Code Bob (Beta)`     | `apps/desktop/package.json`, `APP_BASE_NAME` in `DesktopEnvironment.ts`, `scripts/build-desktop-artifact.ts`, `electron-launcher.mjs` |
| Staged package name (install folder, updater cache) | `t3code`             | `t3code-bob`             | `stagePackageJson` in `scripts/build-desktop-artifact.ts`                                                                             |
| SSH host runtime and data folder                    | `~/.t3`              | `~/.t3-bob`              | `REMOTE_T3_HOME_DIR` in `packages/ssh/src/tunnel.ts` (its tests use the constant)                                                     |

Tests asserting these values are updated to match. A new upstream place that hardcodes one of the upstream values above is a merge finding.

**Releases.** Pushing a tag `v<upstream version>-bob.<n>` (for example `v0.1.11-bob.1`; upstream tags a release before bumping `package.json`, so the tag names the upstream version) runs the fork-owned `.github/workflows/release-bob.yml`. It calls upstream's `release-desktop.yml` on GitHub-hosted runners, unsigned, and publishes the Apple Silicon and Intel `.dmg` plus server archives for macOS arm64 and Linux x64/arm64. Upstream's `release.yml` must stay disabled, since its tag filter matches these tags.

- `CLI_RELEASE_REPOSITORY` in `packages/shared/src/cliRelease.ts` points SSH installs and `t3 update` at this repo (`apps/server/src/cli/update.test.ts` and `packages/ssh/src/tunnel.test.ts` assert it), and `RELEASES_URL` in `apps/desktop/src/app/DesktopStartupRecovery.ts` links to its releases.
- `release-bob.yml` publishes the installers as `T3-Code-Bob-<version>-<arch>.dmg`; upstream names them `T3-Code-<version>-<arch>`.
- `scripts/build-desktop-artifact.ts` leaves out the update feed for `-bob.<n>` versions: unsigned macOS builds cannot update in place and the release publishes no updater manifests, so the app's update checks stay off. `scripts/build-desktop-artifact.test.ts` asserts it.
- The `-bob.<n>` suffix is what keeps an SSH host from running a stock `t3` of the same upstream version from its `PATH`.
- The server the app starts on an SSH host stops when the app disconnects or quits. To keep one running, connect once so the host gets the server, disconnect, run `~/.t3-bob/runtime/versions/<version>/t3 service install` on the host, and reconnect once that same binary's `service status` shows it running. The app then uses the service and leaves it running.

**IBM Bob provider.** The `bob` driver lives in fork-owned `packages/provider-bob`, built on the shared ACP adapter. The plan is [issue #1](https://github.com/pham-t-alex/t3code-bob/issues/1). Upstream files register it next to Kiro, each edit marked `Fork:` where the format allows comments:

- `apps/server/src/provider/builtInDrivers.ts`: `BobDriver` and `BobDriverEnv`.
- `packages/client-runtime/src/providerClients.ts`, `apps/server/src/policy/managedProviders.ts`: `bobClient`.
- `packages/contracts/src/model.ts`: default model `default` and display name `IBM Bob`.
- `packages/contracts/src/settings.ts`: `bob` in `DEFAULT_DISABLED_PROVIDER_DRIVERS`, matching the driver's `enabled: false` default.
- `packages/provider-core/src/server/providerAuthFlow.ts`: `awaitingBrowser` on the sign-in context, for a provider that opens the browser itself and has no link to show (desktop Bob). The web client already words a waiting sign-in with no link as "Finish signing in in your browser." Its test is in `providerAuthFlow.test.ts`.
- Usage page: `bob` in `UsageProviderKind` and an optional `unsplitTokens` in `UsageTokenTotals` (`packages/contracts/src/usage.ts`). Bob 2.1 records only Bobcoin spend, so its reader derives an unsplit token total. `totalTokens` (`packages/provider-core/src/server/usage.ts`), `apps/server/src/usage/usageAggregation.ts` and `packages/shared/src/usageMerge.ts` add it in, `tokenTypeSegments` (`apps/web/src/components/usage/usageBreakdown.ts`) shows it as "Other", and Bob's label and color sit in web `usageProviders.ts` and mobile `usageProviders.ts` / `providerColors.ts`. A new upstream place that sums the four token fields is a merge finding.
- `apps/server/package.json`, `packages/client-runtime/package.json`, `pnpm-lock.yaml` (regenerate with `vp i` on conflict), the root `package.json` `knip:check:exports` list, and `scripts/release-smoke.ts`.

**OS link scheme.** Bob registers `t3code-bob://` with the OS and never claims `t3code://`, so links meant for one app cannot open the other. The renderer origin stays `t3code://app`, which stock servers' CORS and T3 Connect expect; links are translated only at the OS boundary.

- `toOsAppLink` / `fromOsAppLink` in `packages/shared/src/remote.ts` do the translation, and `getOsLinkScheme` in `apps/desktop/src/electron/ElectronProtocol.ts` names the scheme.
- Outgoing: `codexAuthHandoffUrl` (`packages/shared/src/codexAuthHandoff.ts`), and the provider sign-in `returnUrl` the client sends (`signIn` in `apps/web/src/components/settings/CodexSetupSection.tsx`). The client names its own scheme because a server cannot tell which app started the sign-in; `providerAuthReturnUrl` accepts `t3code-bob:`. A stock server rejects that return URL and its callback page asks the user to return manually.
- Incoming: launch args, `open-url`, and `second-instance` in `apps/desktop/src/app/DesktopClerk.ts`; relaunch arg filtering in `DesktopLifecycle.ts`.
- Registration: Clerk's `renderer.scheme` in `DesktopClerk.ts` (Clerk calls `setAsDefaultProtocolClient` on every launch, on every platform, and receives OAuth callbacks there). Clerk also calls `registerSchemesAsPrivileged`, which replaces Electron's list, so `createDesktopClerkBridge` re-registers the renderer's schemes afterwards; `protocols` for macOS and Linux in `scripts/build-desktop-artifact.ts`; `DesktopLinuxUrlHandler.ts` and `DesktopPreReadyPlatform.ts`; `electron-launcher.mjs`.
- Any new upstream code that builds or matches a production `t3code:` link for the OS must go through these helpers.

T3 Connect sign-in from Bob returns on `t3code-bob://app/`; it only works if upstream's Clerk instance accepts that redirect.

Side-by-side installs target macOS first, then Windows. Linux `.deb`/AppImage packages still share executable, desktop-entry, and doc paths with stock T3 Code; do not install both there.

Still shared with stock T3 Code, on purpose:

- On first launch, Bob imports once from a legacy V1 profile (`T3 Code (Alpha)` or `t3code`) if one exists: UI local storage on every platform, plus Chromium's `Local State` on Windows. Never the database, and never the current `t3code-v2` profile.
- `t3code://` links made outside Bob (prompt links from app.t3.codes, pairing links printed for the mobile app) open stock T3 Code, not Bob.
- The `t3` shell command resolves to whichever install is first on `PATH`. `scripts/install.sh` installs stock T3 Code into `~/.t3`; Bob's server reaches a host through its release archives and the SSH launcher.
- The background boot service (`t3code`) and MDM policy identifiers. Bob's `t3 service install` serves `~/.t3-bob`, where the SSH launcher finds it, but there is one service per user, so it refuses while stock T3 Code's is installed.
- A WSL backend's runtime in the distro's `~/.t3/wsl-runtime`. Its data is in the distro's `~/.t3-bob`, the server's default home.
- Mobile app, hosted web app, and marketing identifiers. The fork does not ship those.
