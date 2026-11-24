import {feedEvents} from './calendar-feed-events';

self.onmessage = ({data}: MessageEvent<{text:string; from:string; to:string}>) => {
  try { self.postMessage({events: feedEvents(data.text, data.from, data.to)}); }
  catch (error) { self.postMessage({error: error instanceof Error ? error.message : 'Flux illisible.'}); }
};
