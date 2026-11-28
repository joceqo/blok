import React from 'react';
import { FileText, X } from 'lucide';
import { Icon } from './icon';
import type { ChatAttachment } from './attachments';

export function AttachmentPreview({item, remove, disabled}: {item: ChatAttachment; remove?: () => void; disabled?: boolean}) {
  const preview = item.kind === 'image' ? item.url : item.kind === 'video' ? item.frames[0]?.url : undefined;
  return <span data-blok-chat-file={item.kind} title={item.name}>
    {preview ? <img src={preview} alt={item.name}/> : <Icon icon={FileText} size={18}/>}
    {item.kind !== 'image' && <span data-blok-chat-file-label=""><strong>{item.name}</strong>
      {item.kind === 'video' && <small>{item.frames.length} {item.frames.length === 1 ? 'vue' : 'vues'} · sans son</small>}</span>}
    {remove && <button type="button" disabled={disabled} aria-label={'Retirer ' + item.name} onClick={remove}><Icon icon={X} size={12}/></button>}
  </span>;
}
