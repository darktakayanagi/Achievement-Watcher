const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

const QUERY_USER_NOTIFICATION_STATE = {
  1: 'QUNS_NOT_PRESENT',
  2: 'QUNS_BUSY',
  3: 'QUNS_RUNNING_D3D_FULL_SCREEN',
  4: 'QUNS_PRESENTATION_MODE',
  5: 'QUNS_ACCEPTS_NOTIFICATIONS',
  6: 'QUNS_QUIET_TIME',
  7: 'QUNS_APP',
};

async function queryUserNotificationState() {
  try {
    const { stdout } = await execFileAsync('powershell.exe', [
      '-NoProfile',
      '-Command',
      `
        Add-Type -AssemblyName shell32;
        $state = 0;
        [shell32]::SHQueryUserNotificationState([ref]$state);
        Write-Output $state;
      `,
    ]);
    const state = parseInt(stdout.trim(), 10);
    return QUERY_USER_NOTIFICATION_STATE[state];
  } catch (err) {
    console.error('Failed to query notification state:', err);
    return null;
  }
}

async function isFullscreenAppRunning() {
  const state = await queryUserNotificationState();
  return ['QUNS_BUSY', 'QUNS_RUNNING_D3D_FULL_SCREEN', 'QUNS_PRESENTATION_MODE', 'QUNS_APP'].includes(state);
}

module.exports = { isFullscreenAppRunning };
