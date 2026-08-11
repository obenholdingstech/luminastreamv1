-- Clone modal (11 Aug 2026): the selected language/accent is part of the
-- voice's identity, so it must SURVIVE HEALING — a re-provisioned clone
-- without its conditioning hint would be a subtly different voice
-- (CodeRabbit, PR 106). Nullable: pre-modal clones and auto-detect both
-- read as "let the vendor infer".

ALTER TABLE user_voices ADD COLUMN language TEXT;
