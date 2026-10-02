/**
 * The About window's process (`/bin/about.json` entry `apps/about/proc`): it owns the window;
 * the view reads everything it shows through view-port calls (uname, proc.cred, statfs, quota).
 */
import { windowOwnerProgram } from '../src/descriptor.ts';

const about = windowOwnerProgram({
  app: 'about',
  title: 'About Plotinium',
  icon: 'atom',
  width: 780,
  height: 700,
});

export default about;
