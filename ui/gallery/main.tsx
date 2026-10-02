import '../src/tokens/tokens.css';
import '../src/tokens/motion.css';
import '../src/tokens/fonts.css';

import { render } from 'solid-js/web';

import { GalleryApp } from './GalleryApp.tsx';

const root = document.getElementById('root');
if (root !== null) render(() => <GalleryApp />, root);
