import { createApp } from 'vue';
import '@mdi/font/css/materialdesignicons.css';
import CompanionApp from './CompanionApp.vue';
import '../assets/style.css';

if (window.matchMedia('(prefers-color-scheme: light)').matches) {
  document.documentElement.classList.add('theme-light');
}

if (navigator.platform.toUpperCase().includes('MAC')) {
  document.documentElement.classList.add('os-macos');
}

createApp(CompanionApp).mount('#app');
