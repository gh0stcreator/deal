import { describe, expect, it } from 'vitest';
import {
  createParticipantIntake,
  IntakeFieldOrder,
  IntakeStates
} from '../../src/domain/intake/types.js';
import {
  confirmSummary,
  editIntakeField,
  reopenCompletedIntake,
  setSummaryPendingConfirmation,
  startIntake,
  submitIntakeField
} from '../../src/domain/intake/stateMachine.js';
import { InvalidStateTransitionError } from '../../src/domain/session/errors.js';

const NOW = new Date('2026-01-02T00:00:00.000Z');

describe('participant intake state machine', () => {
  it('enforces start transitions', () => {
    const intake = createParticipantIntake('i-1', 's-1', 'p-1', 'PARTY_A', NOW);
    const started = startIntake(intake, NOW);

    expect(started.state).toBe(IntakeStates.IN_PROGRESS);
    expect(started.currentField).toBe('facts');

    expect(() => startIntake({ ...started, state: IntakeStates.COMPLETED }, NOW)).toThrow(
      InvalidStateTransitionError
    );
  });

  it('moves to summary pending only after all required fields are complete', () => {
    let intake = startIntake(createParticipantIntake('i-1', 's-1', 'p-1', 'PARTY_A', NOW), NOW);

    for (const field of IntakeFieldOrder) {
      intake = submitIntakeField(intake, field, `raw ${field}`, `normalized ${field}`, NOW);
    }

    expect(intake.state).toBe(IntakeStates.SUMMARY_PENDING_CONFIRMATION);
    expect(intake.currentField).toBeNull();
    expect(intake.normalizedPositionModel).not.toBeNull();
  });

  it('requires exact generated summary to complete', () => {
    let intake = startIntake(createParticipantIntake('i-1', 's-1', 'p-1', 'PARTY_A', NOW), NOW);

    for (const field of IntakeFieldOrder) {
      intake = submitIntakeField(intake, field, `raw ${field}`, `normalized ${field}`, NOW);
    }

    intake = setSummaryPendingConfirmation(intake, 'summary v1', NOW);

    expect(() => confirmSummary(intake, 'summary v2', NOW)).toThrow();

    const completed = confirmSummary(intake, 'summary v1', NOW);
    expect(completed.state).toBe(IntakeStates.COMPLETED);
    expect(completed.confirmedSummary).toBe('summary v1');
  });

  it('supports edit before confirmation and blocks edit after completion', () => {
    let intake = startIntake(createParticipantIntake('i-1', 's-1', 'p-1', 'PARTY_A', NOW), NOW);

    for (const field of IntakeFieldOrder) {
      intake = submitIntakeField(intake, field, `raw ${field}`, `normalized ${field}`, NOW);
    }

    intake = setSummaryPendingConfirmation(intake, 'summary v1', NOW);

    const edited = editIntakeField(intake, 'facts', 'new raw', 'new normalized', NOW);
    expect(edited.state).toBe(IntakeStates.SUMMARY_PENDING_CONFIRMATION);

    const completed = confirmSummary(
      setSummaryPendingConfirmation(edited, 'summary v2', NOW),
      'summary v2',
      NOW
    );

    expect(() =>
      editIntakeField(completed, 'facts', 'x', 'y', NOW)
    ).toThrow(InvalidStateTransitionError);

    const reopened = reopenCompletedIntake(completed, NOW);
    expect(reopened.state).toBe(IntakeStates.IN_PROGRESS);
  });
});
