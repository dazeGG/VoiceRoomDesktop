# Releasing Voice Room Desktop

Releases are built by GitHub Actions from git tags. Do not upload desktop artifacts manually.

## Versioning

Use semver in `package.json` and tag releases as `vX.Y.Z`.

The release workflow validates that the tag matches `package.json`:

```text
package.json version: 1.3.0
git tag: v1.3.0
```

If they do not match, CI fails before building installers.

## Create a release

1. Update the app version:

   ```bash
   npm version 1.3.0 --no-git-tag-version
   ```

2. Commit the version bump and any release changes:

   ```bash
   git add package.json package-lock.json
   git commit -m "Release v1.3.0"
   ```

3. Create and push the tag:

   ```bash
   git tag v1.3.0
   git push origin main
   git push origin v1.3.0
   ```

4. GitHub Actions builds:

   - macOS `.dmg` on a macOS runner.
   - Windows `.exe` on a Windows runner with MSVC.
   - Native audio helpers on their matching platforms.

5. The workflow creates a GitHub Release and uploads the artifacts.

## Configuration

The workflow uses the repository variable `VOICE_ROOM_URL` when it is set. If the variable is absent, it falls back to:

```text
https://voiceroom.ru
```

Set it in GitHub:

```text
Settings -> Secrets and variables -> Actions -> Variables -> VOICE_ROOM_URL
```

## Signing

The current workflow builds unsigned artifacts. Future production releases should add:

- Apple Developer ID signing and notarization for macOS.
- Authenticode signing for Windows.
