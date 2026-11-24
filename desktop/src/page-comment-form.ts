import type { StoredThread } from '../../src/tools/database/database-comments-store';

export interface PageCommentInput { text: string; threadId?: string; requestId: string }

export function pageCommentForm(post: (message: PageCommentInput) => Promise<void>) {
  const form = document.createElement('form');
  form.setAttribute('data-page-comment-form', '');
  const thread = document.createElement('select');
  thread.setAttribute('aria-label', 'Discussion');
  thread.add(new Option('Nouvelle discussion', ''));
  const input = document.createElement('textarea');
  input.placeholder = 'Écrire un commentaire…';
  input.setAttribute('aria-label', 'Commentaire');
  input.required = true;
  const submit = document.createElement('button');
  submit.type = 'submit';
  submit.textContent = 'Publier';
  const message = document.createElement('span');
  message.setAttribute('role', 'status');
  let request: PageCommentInput | undefined;
  form.append(thread, input, submit, message);
  form.onsubmit = async event => {
    event.preventDefault();
    const text = input.value.trim();
    if (!text || submit.disabled || form.hidden) return;
    if (new TextEncoder().encode(text).length > 16000) {
      message.textContent = 'Ce commentaire est trop long.';
      return;
    }
    const threadId = thread.value || undefined;
    if (!request || request.text !== text || request.threadId !== threadId) {
      request = { text, threadId, requestId: crypto.randomUUID() };
    }
    submit.disabled = input.disabled = thread.disabled = true;
    message.textContent = 'Envoi…';
    try {
      await post(request);
      input.value = '';
      request = undefined;
      message.textContent = 'Commentaire publié.';
    } catch {
      message.textContent = 'Envoi non confirmé. Votre brouillon est conservé ici.';
    } finally {
      submit.disabled = input.disabled = thread.disabled = false;
    }
  };
  return { form, refresh(threads: StoredThread[]) {
    const value = thread.value;
    thread.replaceChildren(new Option('Nouvelle discussion', ''));
    for (const item of threads) {
      if (!item.data.resolved) thread.add(new Option(item.data.text.slice(0, 90), item.id));
    }
    if (value && !Array.from(thread.options).some(option => option.value === value)) {
      const closed = new Option('Discussion indisponible', value);
      closed.disabled = true;
      thread.add(closed);
    }
    thread.value = value;
  } };
}
