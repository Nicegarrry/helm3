# Pi thinking policy

Pi workers always pass a validated thinking level from trusted runtime
configuration to the pinned Pi SDK. When the host does not supply one, Helm
explicitly requests `medium`; it does not rely on Pi's implicit default. The
configuration receipt records the requested level and the SDK-selected level.

This is not evidence that a provider used, disabled, or bounded reasoning. In
particular, the fixed Kimi route has no proven provider reasoning-off mapping:
Pi's `off` setting may only omit a generic request field. Spend, output, and
request guards remain separate from this configuration.
