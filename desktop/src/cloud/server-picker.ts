import {shellText} from '../shell-i18n';
import {button, el, field} from '../ui/dom';
import {serverOrigin} from '../workspace-registry';

export function mountServerPicker(root: HTMLElement, onServer: (origin: string) => void, onBack: () => void): void {
  const view = el('div', {attribute: 'data-cloud-gateway'});
  view.setAttribute('data-blok-interface', '');
  const main = el('main', {attribute: 'data-cloud-narrow'});
  const title = el('h1', {text:shellText("Se connecter à un serveur distant")});
  const form = el('form', {attribute:'data-cloud-stack'});
  const address = field({form, name:'server', label:shellText("Adresse du serveur"), type:'url'});
  address.placeholder = 'https://votre-serveur.fr';
  address.setAttribute('autocomplete', 'url');
  address.spellcheck = false;
  address.oninput = () => address.setCustomValidity('');
  form.append(button({label:shellText("Continuer"), primary:true, block:true, type:'submit', onClick() {}}));
  form.onsubmit = event => {
    event.preventDefault();
    try { onServer(serverOrigin(address.value.trim())); }
    catch { address.setCustomValidity('Saisissez une adresse de serveur HTTPS valide.'); address.reportValidity(); }
  };
  main.append(title, form, button({label:shellText("Retour à mon espace"), onClick:onBack}));
  view.append(main); root.replaceChildren(view); address.focus();
}
