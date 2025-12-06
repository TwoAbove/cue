export interface Clock {
  now(): number;
}

export const WallClock: Clock = {
  now: () => Date.now(),
};
