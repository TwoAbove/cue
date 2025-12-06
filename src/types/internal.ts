// Branded symbols to hide internal properties from the public API and prevent accidental access.
export const _name = Symbol.for("cue_name");
export const _state = Symbol.for("cue_state");
export const _messages = Symbol.for("cue_messages");
export const _tag = Symbol.for("cue_tag");
export const _initialStateFn = Symbol.for("cue_initialStateFn");
export const _upcasters = Symbol.for("cue_upcasters");
export const _handlers = Symbol.for("cue_handlers");
export const _persistence = Symbol.for("cue_persistence");
export const _versions = Symbol.for("cue_versions");
