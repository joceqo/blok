import {initializeShellLanguage} from './shell-i18n';

// Menus and keyboard commands build their labels when the shell modules first load.
void initializeShellLanguage().catch(() => initializeShellLanguage('fr')).then(() => import('./main'));
