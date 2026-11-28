// A local video element uses the codecs available in the desktop webview.
export interface VideoFrame { url: string; seconds: number }

function waitForVideo(video: HTMLVideoElement, event: 'loadeddata' | 'seeked', start: () => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = () => { cleanup(); resolve(); };
    const fail = () => { cleanup(); reject(new Error('Vidéo illisible. Essaie une version MP4 encodée en H.264.')); };
    const cleanup = () => {
      clearTimeout(timer);
      video.removeEventListener(event, done);
      video.removeEventListener('error', fail);
    };
    const timer = setTimeout(fail, 15_000);
    video.addEventListener(event, done, {once:true});
    video.addEventListener('error', fail, {once:true});
    try { start(); } catch { fail(); }
  });
}

export async function sampleVideo(file: File, limit: number): Promise<VideoFrame[]> {
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  const url = URL.createObjectURL(file);
  try {
    await waitForVideo(video, 'loadeddata', () => { video.src = url; });
    if (!Number.isFinite(video.duration) || video.duration <= 0 || !video.videoWidth)
      throw new Error('La durée ou les dimensions de cette vidéo sont illisibles.');
    const canvas = document.createElement('canvas');
    const scale = Math.min(1, 960 / Math.max(video.videoWidth, video.videoHeight));
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Impossible de lire les images de la vidéo.');
    const count = Math.min(limit, Math.max(1, Math.ceil(video.duration * 2)));
    const frames: VideoFrame[] = [];
    for (let i = 0; i < count; i++) {
      const seconds = video.duration * (i + 0.5) / count;
      await waitForVideo(video, 'seeked', () => { video.currentTime = seconds; });
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      frames.push({seconds, url:canvas.toDataURL('image/jpeg', 0.75)});
    }
    return frames;
  } finally {
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(url);
  }
}
