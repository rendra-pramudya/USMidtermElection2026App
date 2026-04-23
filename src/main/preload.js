'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getStats: () => ipcRenderer.invoke('get-stats'),
  getEvents: () => ipcRenderer.invoke('get-events'),
  getConfig: () => ipcRenderer.invoke('get-config'),
  pushNow: () => ipcRenderer.invoke('push-now'),
  applyOverride: (override) => ipcRenderer.invoke('apply-override', override),
  clearOverrides: () => ipcRenderer.invoke('clear-overrides'),
  onEvent: (handler) => {
    const listener = (_e, evt) => handler(evt);
    ipcRenderer.on('event', listener);
    return () => ipcRenderer.removeListener('event', listener);
  },
  // Election dashboard
  getElectionData: () => ipcRenderer.invoke('get-election-data'),
  getSvg:          () => ipcRenderer.invoke('get-svg'),

  // Manual overrides (field editing)
  fieldEdit:    (override)  => ipcRenderer.invoke('field-edit',  override),
  fieldEdits:   (overrides) => ipcRenderer.invoke('field-edits', overrides),
  clearOverrides: ()        => ipcRenderer.invoke('clear-overrides'),
});
