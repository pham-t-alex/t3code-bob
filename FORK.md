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

## Divergences from upstream

Review every sync PR against this list: each item must survive the merge, and conflicts here are expected.

**Install identity.** The fork installs beside stock T3 Code without sharing data.

| Value                                               | Upstream             | Fork                     | Where                                                                                                                                 |
| --------------------------------------------------- | -------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| Data folder                                         | `~/.t3`              | `~/.t3-bob`              | `apps/desktop/src/app/DesktopStatePaths.ts`                                                                                           |
| Electron profile                                    | `t3code-v2`          | `t3code-bob`             | `apps/desktop/src/app/DesktopUserData.ts`                                                                                             |
| App ID                                              | `com.t3tools.t3code` | `com.t3tools.t3code.bob` | `scripts/build-desktop-artifact.ts`, `apps/desktop/src/app/DesktopEnvironment.ts`, `apps/desktop/scripts/electron-launcher.mjs`       |
| Product name                                        | `T3 Code`            | `T3 Code Bob`            | `apps/desktop/package.json`, `APP_BASE_NAME` in `DesktopEnvironment.ts`, `scripts/build-desktop-artifact.ts`, `electron-launcher.mjs` |
| Staged package name (install folder, updater cache) | `t3code`             | `t3code-bob`             | `stagePackageJson` in `scripts/build-desktop-artifact.ts`                                                                             |

Tests asserting these values are updated to match. A new upstream place that hardcodes one of the upstream values above is a merge finding.

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
- The `t3` shell command resolves to whichever install is first on `PATH`.
- The background boot service (`t3code`) and MDM policy identifiers.
- A WSL backend's data in the distro's `~/.t3`.
- Mobile app, hosted web app, and marketing identifiers. The fork does not ship those.
