import React from 'react';
import { createRoot } from 'react-dom/client';
import '@gitroom/extension/pages/popup/index.css';
import './index.css';
import '@gitroom/extension/assets/styles/tailwind.css';
import Panel from '@gitroom/extension/pages/panel/Panel';

function init() {
  const rootContainer = document.querySelector('#__root');
  if (!rootContainer) throw new Error("Can't find Panel root element");
  const root = createRoot(rootContainer);
  root.render(<Panel />);
}

init();
