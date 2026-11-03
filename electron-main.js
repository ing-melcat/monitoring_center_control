const { app, BrowserWindow } = require('electron');
const path = require('path');

// Inicia el servidor local Express + WebSocket + node-pty
require('./server.js');

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 680,
    title: 'RUR | CENTRO DE CONTROL',
    backgroundColor: '#020716',
    icon: path.join(__dirname, 'public', 'assets', process.platform === 'win32' ? 'rur.ico' : 'isotipo.png'),
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  mainWindow.loadURL('http://127.0.0.1:3000');

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  app.quit();
});
