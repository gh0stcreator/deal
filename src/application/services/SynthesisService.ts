import { Clock } from '../ports/Clock.js';
import { IdGenerator } from '../ports/IdGenerator.js';
import { IntakeRepository } from '../ports/IntakeRepository.js';
import { MediationSummaryRepository } from '../ports/MediationSummaryRepository.js';
import { SessionRepository } from '../ports/SessionRepository.js';
import { SynthesisMapper } from '../ports/SynthesisMapper.js';
import { IntakeFieldOrder, IntakeStates, NormalizedPositionModel } from '../../domain/intake/types.js';
import { SessionNotFoundError } from '../../domain/session/errors.js';
import {
  markReadyForProposal,
  markSynthesisCompleted
} from '../../domain/session/stateMachine.js';
import { SessionStates } from '../../domain/session/types.js';
import { SynthesisPreconditionError } from '../../domain/synthesis/errors.js';
import { MediationSummary } from '../../domain/synthesis/types.js';

export class SynthesisService {
  constructor(
    private readonly sessionRepository: SessionRepository,
    private readonly intakeRepository: IntakeRepository,
    private readonly summaryRepository: MediationSummaryRepository,
    private readonly mapper: SynthesisMapper,
    private readonly idGenerator: IdGenerator,
    private readonly clock: Clock
  ) {}

  async synthesizeCase(sessionId: string): Promise<MediationSummary> {
    const session = await this.sessionRepository.findById(sessionId);
    if (!session) {
      throw new SessionNotFoundError();
    }

    if (session.state !== SessionStates.READY_FOR_SYNTHESIS) {
      throw new SynthesisPreconditionError(
        `Session must be in READY_FOR_SYNTHESIS, got ${session.state}.`
      );
    }

    const confirmed = await this.intakeRepository.findConfirmedNormalizedModels(sessionId);

    if (confirmed.length !== 2) {
      throw new SynthesisPreconditionError('Synthesis requires exactly two participant models.');
    }

    const partyA = confirmed.find((item) => item.participantRole === 'PARTY_A');
    const partyB = confirmed.find((item) => item.participantRole === 'PARTY_B');

    if (!partyA || !partyB) {
      throw new SynthesisPreconditionError('Both PARTY_A and PARTY_B models are required.');
    }

    this.assertConfirmedModel(partyA.normalizedPositionModel, partyA.state, partyA.confirmedSummary);
    this.assertConfirmedModel(partyB.normalizedPositionModel, partyB.state, partyB.confirmedSummary);

    const aligned = {
      partyA: this.alignModel(partyA.normalizedPositionModel!),
      partyB: this.alignModel(partyB.normalizedPositionModel!)
    };

    const structured = await this.mapper.synthesize(aligned);

    const latest = await this.summaryRepository.findLatestByCaseId(sessionId);
    const summary: MediationSummary = {
      id: this.idGenerator.nextId(),
      caseId: sessionId,
      version: latest ? latest.version + 1 : 1,
      content: structured,
      createdAt: this.clock.now()
    };

    await this.summaryRepository.save(summary);
    const synthesisCompleted = markSynthesisCompleted(session, this.clock.now());
    const readyForProposal = markReadyForProposal(synthesisCompleted, this.clock.now());
    await this.sessionRepository.save(readyForProposal);

    return summary;
  }

  private assertConfirmedModel(
    model: NormalizedPositionModel | null,
    state: (typeof IntakeStates)[keyof typeof IntakeStates],
    confirmedSummary: string | null
  ): void {
    if (state !== IntakeStates.COMPLETED) {
      throw new SynthesisPreconditionError('Intake must be COMPLETED before synthesis.');
    }

    if (!confirmedSummary) {
      throw new SynthesisPreconditionError('Confirmed summary is required for synthesis.');
    }

    if (!model) {
      throw new SynthesisPreconditionError('Normalized position model is required for synthesis.');
    }

    for (const field of IntakeFieldOrder) {
      const value = model[field];
      if (!value || !value.trim()) {
        throw new SynthesisPreconditionError(`Missing required normalized field: ${field}.`);
      }
    }
  }

  private alignModel(model: NormalizedPositionModel): NormalizedPositionModel {
    const aligned = {} as NormalizedPositionModel;

    for (const field of IntakeFieldOrder) {
      aligned[field] = model[field].trim().replace(/\s+/g, ' ');
    }

    return aligned;
  }
}
