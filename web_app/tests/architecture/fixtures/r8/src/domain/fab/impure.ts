// R8 negative fixture: non-injected clock/random/timer/network/DOM access in domain/**.
export function wallClock(): number { return Date.now(); }
export function newClock(): Date { return new Date(); }
export function random(): number { return Math.random(); }
export function later(action: () => void): void { setTimeout(action, 0); }
export function repeat(action: () => void): void { setInterval(action, 1000); }
export function network(): Promise<Response> { return fetch('/api/v1/sites'); }
export function dom(): HTMLElement { return document.createElement('div'); }
export function viewport(): number { return window.innerWidth; }
export function xhr(): XMLHttpRequest { return new XMLHttpRequest(); }
