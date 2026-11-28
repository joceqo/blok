import {expect, it, vi} from 'vitest';
import {createChatComposer} from '../../../src/shell/agent-chat/composer';
import {setChatNewline} from '../../../desktop/src/display-preferences';

it('applies the newline preference to an already open conversation', () => {
  const send = vi.fn();
  const composer = createChatComposer({providers: [{id:'local',label:'Local'}], onSend:send});
  document.body.append(composer.element);
  const enter = (modifiers: KeyboardEventInit = {}) => {
    const event = new KeyboardEvent('keydown', {key:'Enter', bubbles:true, cancelable:true, ...modifiers});
    composer.field.dispatchEvent(event);
    return event.defaultPrevented;
  };
  try {
    composer.setText('Premier message');
    expect(enter()).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    composer.setText('Deuxième message');
    setChatNewline(true);
    expect(enter()).toBe(false);
    expect(enter({shiftKey:true})).toBe(false);
    expect(enter({isComposing:true})).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
    expect(enter({metaKey:true})).toBe(true);
    composer.setText('Troisième message');
    expect(enter({ctrlKey:true})).toBe(true);
    expect(send).toHaveBeenCalledTimes(3);
  } finally {
    composer.destroy();
    composer.element.remove();
    localStorage.clear();
    document.documentElement.removeAttribute('data-blok-chat-enter-newline');
  }
});
