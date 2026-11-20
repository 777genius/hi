import assert from 'node:assert/strict';
import test from 'node:test';
import { assertRecordingContinuity, companionApiError, needsAnswerQualityReview, recordingIdentity, earlyReplyPreview, parseArgs, transcriptAcceptance, transcriptJunk } from './companion-ua-interview-audio.mjs';

test('term tolerance is explicit and cannot admit empty, low coverage or junk text', () => {
  assert.equal(parseArgs([]).tolerateTermErrors, false);
  assert.equal(parseArgs(['--strict', '--tolerate-term-errors']).tolerateTermErrors, true);
  const missing = [{ term: 'Flutter', found: false }];
  assert.equal(transcriptAcceptance('I build mobile applications.', 0.8, missing, 0.5, false).ok, false);
  const tolerated = transcriptAcceptance('I build mobile applications.', 0.8, missing, 0.5, true);
  assert.equal(tolerated.ok, true);
  assert.equal(tolerated.termsOk, false);
  for (const [text, score] of [['', 1], ['unrelated words', 0.2], ['Glossary: Flutter Dart', 1]] as const) {
    assert.equal(transcriptAcceptance(text, score, missing, 0.5, true).ok, false);
  }
});

test('known glossary echoes and short loops fail while meaningful repeated terminology passes', () => {
  for (const text of [
    'Glossary', 'Glossary: Flutter Dart', 'Коректна відповідь Glossary: Flutter Dart', 'A useful answer. Glossary: widget tree',
    'widget tree widget tree widget tree',
    'Потік даних потік даних потік даних',
    'correct sentence. w.w.w.w.w',
    'flutter flutter flutter flutter flutter',
  ]) assert.equal(transcriptJunk(text).junk, true, text);
  for (const text of [
    'Flutter builds widgets, and Flutter also supports desktop applications.',
    'widget tree, widget tree traversal uses depth first order.',
    'We maintain a glossary in the documentation.',
  ]) assert.equal(transcriptJunk(text).junk, false, text);
});


test('early reply is opt in and requires a substantial real system preview', () => {
  assert.equal(parseArgs([]).earlyReplyEvery, 0);
  assert.equal(parseArgs(['--early-reply-every', '4']).earlyReplyEvery, 4);
  for (const value of ['0', '-1', '1.5', 'NaN']) {
    assert.throws(() => parseArgs(['--early-reply-every', value]));
  }
  const question = 'Explain Flutter widget lifecycle and asynchronous state management';
  assert.equal(earlyReplyPreview(question, '').eligible, false);
  assert.equal(earlyReplyPreview(question, 'Hello interview').eligible, false);
  const preview = earlyReplyPreview(question, 'Explain Flutter widget lifecycle and asynchronous state');
  assert.equal(preview.eligible, true);
  assert.equal(preview.text, 'Explain Flutter widget lifecycle and asynchronous state');
  assert.ok(preview.coverage >= 0.6);
});


test('API failures retain only endpoint pathname and status', () => {
  const secret = 'SENSITIVE_TOKEN_123';
  const path = `/api/state?token=${secret}&extra=private`;
  assert.equal(companionApiError(path, 403).message, '/api/state: HTTP 403');
  assert.equal(companionApiError(path).message, '/api/state: transport failure');
  assert.ok(!companionApiError(path, 403).stack?.includes(secret));
});

test('continuous recording binds real session, instance and conversation identity', () => {
  const state = { recording: { status: 'Recording', activeSessionId: 42 }, controls: { instanceId: 'app-a', conversationGeneration: 7 }, timeline: [{ generation: 1 }] };
  const identity = recordingIdentity(state);
  assert.doesNotThrow(() => assertRecordingContinuity(identity, { ...state, timeline: [{ generation: 99 }] }));
  assert.throws(() => assertRecordingContinuity(identity, { ...state, recording: { ...state.recording, activeSessionId: 43 } }), /activeSessionId/);
  assert.throws(() => assertRecordingContinuity(identity, { ...state, controls: { ...state.controls, instanceId: 'app-b' } }), /instanceId/);
  assert.throws(() => assertRecordingContinuity(identity, { ...state, controls: { ...state.controls, conversationGeneration: 8 } }), /conversationGeneration/);
  assert.throws(() => assertRecordingContinuity(identity, { ...state, controls: {} }), /instanceId/);
  assert.throws(() => assertRecordingContinuity(identity, { ...state, recording: { ...state.recording, status: 'Idle' } }), /stopped/);
});

test('manual review remains required for missing, failed or flagged judgments', () => {
  const turns = [{ id: 1, aiRequested: true, ai: { ok: true, qualityNeedsReview: false } }];
  const good = { id: 1, correct: 2, context: 2, concise: 2, noQuestions: true, russian: true, firstPerson: true, issue: '' };
  assert.equal(needsAnswerQualityReview(true, turns, [], [good]), false);
  assert.equal(needsAnswerQualityReview(false, turns, [], [good]), true);
  assert.equal(needsAnswerQualityReview(true, turns, [], []), true);
  assert.equal(needsAnswerQualityReview(true, turns, [], [{ id: 1, error: 'timeout' }]), true);
  assert.equal(needsAnswerQualityReview(true, turns, [], [{ ...good, issue: 'lost context' }]), true);
  assert.equal(needsAnswerQualityReview(true, turns, [], [{ ...good, context: 1 }]), true);
  assert.equal(needsAnswerQualityReview(true, [{ ...turns[0], ai: { ok: true, qualityNeedsReview: true } }], [], [good]), true);
});
