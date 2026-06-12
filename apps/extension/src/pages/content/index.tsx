import { createRoot } from 'react-dom/client';
import './style.css';
import { MainContent } from '@gitroom/extension/pages/content/main.content';
import { EXTENSION_ROOT_ID } from '@gitroom/helpers/extension/brand';

// Unique container id (NOT the generic "__root") so we never collide with another
// extension (e.g. the official Postiz extension) that injects its own root on the
// same page. Render into the div directly rather than re-querying by id, which
// could otherwise grab a different extension's element.
const div = document.createElement('div');
div.id = EXTENSION_ROOT_ID;
document.body.appendChild(div);

const root = createRoot(div);
root.render(<MainContent />);
