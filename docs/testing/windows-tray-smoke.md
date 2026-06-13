# Windows tray lifecycle smoke test

Run this checklist on a packaged Windows build before merging or releasing changes that touch the Electron window lifecycle.

## Setup

1. Build or install the Windows app artifact.
2. Start Voice Room normally, not with `VOICE_ROOM_PICKER_PREVIEW=1`.
3. Confirm the main window is visible and a Voice Room tray icon is present.

## Checks

- Click the titlebar **X**: the main window hides and the process remains running in the tray.
- Click the tray icon: the same main window is restored and focused.
- Click the titlebar **X** again, then use the tray menu item **Открыть Voice Room**: the main window is restored and focused.
- Press **Alt+F4** while the main window is focused: the app exits and the tray icon is removed.
- Start the app again, then use the tray menu item **Выход**: the app exits and the tray icon is removed.
- Start with `VOICE_ROOM_PICKER_PREVIEW=1`, close the preview window, and confirm the app exits instead of staying tray-only.
