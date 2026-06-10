# Code signing policy

Free code signing for Windows release artifacts is provided by [SignPath.io](https://about.signpath.io), certificate by [SignPath Foundation](https://signpath.org).

## Team roles

| Role | Responsibility | Members |
|------|----------------|---------|
| Authors / Committers | Maintain source code and build scripts | [@dazeGG](https://github.com/dazeGG) |
| Reviewers | Review pull requests before merge to `main` | [@dazeGG](https://github.com/dazeGG) |
| Approvers | Approve SignPath signing requests for release builds | [@dazeGG](https://github.com/dazeGG) |

## Release signing flow

1. A maintainer merges reviewed changes into `main`.
2. GitHub Actions builds an unsigned Windows portable `.exe` from a release tag.
3. The workflow submits the unsigned artifact to SignPath with GitHub origin verification.
4. An approver reviews and approves the signing request in SignPath.
5. The workflow downloads the signed artifact, regenerates update metadata, and publishes the GitHub Release.

Unsigned Windows artifacts are not published to end users once SignPath signing is enabled.

## Artifact scope

SignPath signs the Windows portable executable produced by this repository, including nested binaries built from this project's source code such as `SafeSystemAudioCapture.exe`.

## Privacy

This desktop shell does not send telemetry on its own.

Network access from the shell is limited to:

- checking and downloading application updates from GitHub Releases
- loading the configured Voice Room web application URL (`https://voiceroom.ru` in production builds)

The hosted Voice Room web application has its own privacy policy and data handling.