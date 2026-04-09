import { randomBytes } from 'node:crypto';

export interface IdGenerator {
  nextId(): string;
}

export class RandomIdGenerator implements IdGenerator {
  nextId(): string {
    return randomBytes(12).toString('hex');
  }
}
