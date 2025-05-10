'use strict';

const { ipcRenderer } = require('electron');

const template = `
    
    <link rel="stylesheet" href="../resources/css/normalize.css" type="text/css"/>
    <link rel="stylesheet" href="../resources/css/fontawesome.css" type="text/css"/>
    <link rel="stylesheet" href="../resources/css/common.css" type="text/css" />
    <link rel="stylesheet" href="../resources/css/titlebar.css" type="text/css" />

    <div class="sf-indicator">
    <ul id="watchdog-status" class="sf-indicator"><span class="status-dot status-orange"></span><span class="status-text">Checking watchdog status...</span> <span id="start-watchdog"></span></ul>
    </div>
    <ul>
      <li id="btn-close"><i class="fas fa-times"></i></li>
      <li id="btn-maximize"><i class="far fa-window-maximize"></i></li>
      <li id="btn-settings"><i class="fas fa-cog"></i></li>
      <li id="btn-minimize"><i class="far fa-window-minimize"></i></li>
    </ul>
`;

export default class titleBar extends HTMLElement {
  constructor() {
    super();

    this.attachShadow({ mode: 'open' }).innerHTML = template;

    this.closeBtn = this.shadowRoot.querySelector('#btn-close');
    this.maximizeBtn = this.shadowRoot.querySelector('#btn-maximize');
    this.settingsBtn = this.shadowRoot.querySelector('#btn-settings');
    this.minimizeBtn = this.shadowRoot.querySelector('#btn-minimize');
    this.watchdogBtn = this.shadowRoot.querySelector('#start-watchdog');
  }

  /* Life Cycle */
  connectedCallback() {
    this.closeBtn.addEventListener('click', this.close.bind(this));
    this.maximizeBtn.addEventListener('click', this.maximize.bind(this));
    this.settingsBtn.addEventListener('click', this.settings.bind(this));
    this.minimizeBtn.addEventListener('click', this.minimize.bind(this));
    this.watchdogBtn.addEventListener('click', this.start_watchdog.bind(this));

    const defaults = [ipcRenderer.invoke('win-isMinimizable'), ipcRenderer.invoke('win-isMaximizable')];

    Promise.allSettled(defaults).then((promises) => {
      const [isMinimizable, isMaximizable] = promises;

      if (isMinimizable.value === true) this.setAttribute('minimizable', '');
      if (isMaximizable.value === true) this.setAttribute('maximizable', '');

      this.update();
    });
  }

  disconnectedCallback() {
    this.closeBtn.removeEventListener('click', this.close.bind(this));
    this.maximizeBtn.removeEventListener('click', this.maximize.bind(this));
    this.settingsBtn.removeEventListener('click', this.settings.bind(this));
    this.minimizeBtn.removeEventListener('click', this.minimize.bind(this));
  }

  /* Update */

  static get observedAttributes() {
    return ['maximizable', 'minimizable', 'insettings'];
  }

  attributeChangedCallback(name, oldValue, newValue) {
    this.update();
  }

  update() {
    if (this.hasAttribute('maximizable')) {
      this.maximizeBtn.style['display'] = 'inline-block';
    } else {
      this.maximizeBtn.style['display'] = 'none';
    }

    if (this.hasAttribute('minimizable')) {
      this.minimizeBtn.style['display'] = 'inline-block';
    } else {
      this.minimizeBtn.style['display'] = 'none';
    }

    if (this.hasAttribute('insettings')) {
      this.settingsBtn.style['pointer-events'] = 'none';
      this.watchdogBtn.style['pointer-events'] = 'none';
    } else {
      this.settingsBtn.style['pointer-events'] = 'initial';
      this.watchdogBtn.style['pointer-events'] = 'initial';
    }
  }

  /* Getter/Setter */
  get maximizable() {
    return this.hasAttribute('maximizable');
  }

  set maximizable(isMaximizable) {
    if (isMaximizable) {
      this.setAttribute('maximizable', '');
    } else {
      this.removeAttribute('maximizable');
    }
  }

  get minimizable() {
    return this.hasAttribute('minimizable');
  }

  set minimizable(isMinimizable) {
    if (isMinimizable) {
      this.setAttribute('minimizable', '');
    } else {
      this.removeAttribute('minimizable');
    }
  }

  get inSettings() {
    return this.hasAttribute('inSettings');
  }

  set inSettings(isInSettings) {
    if (isInSettings) {
      this.setAttribute('inSettings', '');
    } else {
      this.removeAttribute('inSettings');
    }
  }

  /* Custom method */
  close() {
    //this.dispatchEvent(new CustomEvent('close'));
    ipcRenderer.invoke('win-close');
  }

  maximize() {
    //this.dispatchEvent(new CustomEvent('maximize'));
    ipcRenderer.invoke('win-maximize');
  }

  settings() {
    this.dispatchEvent(new CustomEvent('open-settings'));
  }

  minimize() {
    //this.dispatchEvent(new CustomEvent('minimize'));
    ipcRenderer.invoke('win-minimize');
  }

  start_watchdog() {
    ipcRenderer.invoke('start-watchdog');
  }
}
