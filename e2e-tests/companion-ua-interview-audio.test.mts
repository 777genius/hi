import assert from 'node:assert/strict';
import test from 'node:test';
import { earlySubmissionAllowed, previousJudgeContext, waitForAnswer, createAiAttempt, assertRecordingContinuity, companionApiError, needsAnswerQualityReview, recordingIdentity, earlyReplyPreview, parseArgs, transcriptAcceptance, transcriptJunk } from './companion-ua-interview-audio.mjs';

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
    'Glossary files are loaded once at startup.',
    'The project starts. Glossary files are loaded once at startup.',
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


test('failed AI preflight is an attempted failure and cannot escape AI accounting', async () => {
  const rec = { id: 1, aiRequested: false };
  let preflights = 0;
  const attempt = createAiAttempt(rec, async () => {
    preflights += 1;
    throw new Error('state preflight failed');
  });
  const first = attempt();
  assert.equal(rec.aiRequested, true, 'attempt must be counted before the first await');
  assert.equal(attempt(), first, 'normal fallback must join the failed early attempt');
  const ai = await first;
  assert.equal(preflights, 1);
  assert.equal(ai.status, 'exception');
  assert.equal(ai.ok, false);
  const turns = [{ ...rec, ai }];
  const aiTurns = turns.filter((turn) => turn.aiRequested);
  assert.equal(aiTurns.length, 1);
  assert.equal(aiTurns.filter((turn) => !turn.ai.ok).length, 1);
  assert.equal(needsAnswerQualityReview(true, turns, [], []), true);
});


test('answer first observed after deadline is timed out, while timely final passes', async () => {
  const now = Date.now;
  let clock = 1000;
  Date.now = () => clock;
  try {
    const snapshot = { timeline: [{ seq: 1, kind: 'haiku', status: 'final', text: 'Answer' }] };
    const late = await waitForAnswer(0, 100, 1000, async () => { clock = 1101; return snapshot; });
    assert.equal(late.timedOut, true);
    clock = 1000;
    const timely = await waitForAnswer(0, 100, 1000, async () => { clock = 1099; return snapshot; });
    assert.equal(timely.item?.status, 'final');
    assert.equal(Boolean(timely.timedOut), false);
  } finally { Date.now = now; }
});

test('playback ending before early POST skips submission and releases normal attempt', async () => {
  const rec = { aiRequested: false, audio: { questionFinishedAtMs: 123 } };
  let posts = 0;
  let early = true;
  const attempt = createAiAttempt(rec, async () => {
    if (early && !earlySubmissionAllowed(rec)) return { skippedBeforeSubmit: true };
    posts += 1;
    return { status: 'final', ok: true };
  });
  await attempt();
  assert.equal(posts, 0);
  assert.equal(rec.aiRequested, false);
  early = false;
  await attempt();
  await attempt();
  assert.equal(posts, 1);
  assert.equal(rec.aiRequested, true);
});

test('judge context follows report position even with nonmonotonic IDs', () => {
  const turns = [{ id: 10, systemText: 'first question', micText: 'first answer' }, { id: 2, systemText: 'second question', micText: 'second answer' }];
  assert.equal(previousJudgeContext(turns, 0), '');
  assert.match(previousJudgeContext(turns, 1), /first answer/);
  assert.ok(!previousJudgeContext(turns, 1).includes('second answer'));
});
