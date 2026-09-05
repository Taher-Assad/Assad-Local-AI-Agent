import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  captureBrowserMedia,
  classifyMedia,
  collectMediaFromFiles
} from '../src/lib/agent/capture.ts';
import { createMediaArtifact } from '../src/lib/agent/artifacts.ts';

describe('classifyMedia', () => {
  it('recognises image extensions', () => {
    assert.equal(classifyMedia('out.png'), 'image');
    assert.equal(classifyMedia('dir/Chart.JPEG'), 'image');
    assert.equal(classifyMedia('logo.svg'), 'image');
  });

  it('recognises video extensions', () => {
    assert.equal(classifyMedia('run.mp4'), 'video');
    assert.equal(classifyMedia('session.webm'), 'video');
  });

  it('treats .gif as an image so it renders inline', () => {
    assert.equal(classifyMedia('anim.gif'), 'image');
  });

  it('returns null for anything else', () => {
    assert.equal(classifyMedia('src/index.ts'), null);
    assert.equal(classifyMedia('Makefile'), null);
    assert.equal(classifyMedia(''), null);
  });
});

describe('collectMediaFromFiles', () => {
  it('keeps only media files, de-duplicated and in order', () => {
    const media = collectMediaFromFiles([
      'src/index.ts',
      'plot.png',
      'plot.png',
      'demo.mp4',
      'notes.md'
    ]);
    assert.deepEqual(
      media.map(item => [item.kind, item.path]),
      [
        ['image', 'plot.png'],
        ['video', 'demo.mp4']
      ]
    );
  });

  it('returns an empty list when nothing is media', () => {
    assert.deepEqual(collectMediaFromFiles(['a.ts', 'b.json']), []);
    assert.deepEqual(collectMediaFromFiles([]), []);
  });
});

describe('captureBrowserMedia', () => {
  it('reports that capture is unavailable with a usable reason', () => {
    const result = captureBrowserMedia();
    assert.equal(result.captured, false);
    assert.match(result.reason, /headless-browser/);
  });
});

describe('createMediaArtifact', () => {
  it('wraps collected media in a renderable artifact', () => {
    const media = collectMediaFromFiles(['chart.png']);
    const artifact = createMediaArtifact('screenshot', media);
    assert.equal(artifact.kind, 'screenshot');
    assert.equal(artifact.status, 'final');
    assert.equal(artifact.media?.length, 1);
    assert.match(artifact.summary ?? '', /1 image/);
  });

  it('labels recordings in the plural', () => {
    const artifact = createMediaArtifact('browser-recording', [
      { kind: 'video', path: 'a.mp4' },
      { kind: 'video', path: 'b.mp4' }
    ]);
    assert.equal(artifact.title, 'Browser Recording');
    assert.match(artifact.summary ?? '', /2 recordings/);
  });
});
