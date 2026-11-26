import {expect, it} from 'vitest';
import {appUrlForDeepLink, deepLinkFor, deepLinkTarget, handoffTarget, handoffUrl} from './deep-link';
import {buildTabMenuItems} from './tab-menu';

const uuid = '2a7aee31-f541-41e8-9190-6eae552291b8';

it('carries the workspace so a shared page opens in the space that owns it', () => {
  expect(deepLinkFor(`https://blok.example/p/sprints-${uuid}`, {workspaceId: 'acme'}))
    .toBe(`blok://page/${uuid}?server=https%3A%2F%2Fblok.example&workspace=acme`);
  expect(deepLinkTarget(`blok://page/${uuid}?server=https%3A%2F%2Fblok.example&workspace=acme`))
    .toEqual({pageId: uuid, server: 'https://blok.example', workspaceId: 'acme', local: false});
});

it('marks a page held on this device instead of pointing at a server it has none', () => {
  const link = String(deepLinkFor('https://blok.example/?page=welcome&local=1'));
  expect(link).toBe('blok://page/welcome?local=1');
  expect(deepLinkTarget(link)).toEqual({pageId: 'welcome', local: true});
});

it('refuses a remote link whose server is missing or is not a web origin', () => {
  // Without a server the identifier would resolve against whichever workspace
  // happens to be open, showing the wrong page under a trusted name.
  expect(deepLinkTarget(`blok://page/${uuid}`)).toBeNull();
  expect(deepLinkTarget(`blok://page/${uuid}?server=javascript%3Aalert(1)`)).toBeNull();
  expect(deepLinkTarget(`blok://page/${uuid}?server=file%3A%2F%2F%2Fetc%2Fpasswd`)).toBeNull();
});

it('ignores links that are not a page of this application', () => {
  expect(deepLinkTarget('https://blok.example/p/sprints')).toBeNull();
  expect(deepLinkTarget('blok://workspace/acme')).toBeNull();
  expect(deepLinkTarget('blok://page/')).toBeNull();
  expect(deepLinkTarget('pas une url')).toBeNull();
  expect(deepLinkFor('https://blok.example/')).toBeNull();
  expect(deepLinkFor('https://blok.example/p/page-inconnue')).toBeNull();
});

it('hands boot the URL it already knows how to route, dropping the previous destination', () => {
  expect(appUrlForDeepLink(`blok://page/${uuid}?server=https%3A%2F%2Fblok.example`, 'http://localhost:1420/?page=old&local=1'))
    .toBe(`http://localhost:1420/?page=${uuid}&server=https%3A%2F%2Fblok.example`);
  expect(appUrlForDeepLink('blok://page/welcome?local=1', 'http://localhost:1420/?page=old'))
    .toBe('http://localhost:1420/?page=welcome&local=1');
  expect(appUrlForDeepLink('blok://workspace/acme', 'http://localhost:1420/')).toBeNull();
});

it('round-trips a public page link through the scheme', () => {
  const href = `https://blok.example/p/notes-${uuid}`;
  const link = String(deepLinkFor(href));
  expect(appUrlForDeepLink(link, 'http://localhost:1420/'))
    .toBe(`http://localhost:1420/?page=${uuid}&server=https%3A%2F%2Fblok.example`);
});

it('offers the hand-off to the app only on the web, where it is not already open', () => {
  const href = `https://blok.example/p/notes-${uuid}`;
  const web = buildTabMenuItems({tabId: 'a', tabIds: ['a'], href});
  expect(web[0]).toEqual({action: 'open-in-app', label: 'Ouvrir dans l’application', disabled: false});
  expect(buildTabMenuItems({tabId: 'a', tabIds: ['a'], href, native: true})
    .some((item) => item.action === 'open-in-app')).toBe(false);
});

it('greys the hand-off out when the tab names no page to open', () => {
  const [first] = buildTabMenuItems({tabId: 'a', tabIds: ['a'], href: 'https://blok.example/'});
  expect(first).toEqual({action: 'open-in-app', label: 'Ouvrir dans l’application', disabled: true});
});

it('offers a pasteable web URL, since a browser turns an unknown scheme into a search', () => {
  const href = 'http://localhost:1420/?page=widgets&local=1';
  expect(handoffUrl(href)).toBe('http://localhost:1420/?page=widgets&local=1&open=app');
  expect(handoffTarget('http://localhost:1420/?page=widgets&local=1&open=app'))
    .toBe('blok://page/widgets?local=1');
});

it('hands off a remote page to the workspace that owns it', () => {
  expect(handoffTarget(`https://blok.example/p/notes-${uuid}?open=app`))
    .toBe(`blok://page/${uuid}?server=https%3A%2F%2Fblok.example`);
});

it('leaves an ordinary URL alone, so only an explicit hand-off redirects', () => {
  expect(handoffTarget('http://localhost:1420/?page=widgets&local=1')).toBeNull();
  expect(handoffTarget('http://localhost:1420/?open=app')).toBeNull();
  expect(handoffUrl('http://localhost:1420/')).toBeNull();
});
