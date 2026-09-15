# Cockpit navigation slice

The operator page now provides keyboard accessible, no-JavaScript anchors for Overview, Map, Needs You, Workers, Models and Log. It remains one rendered page backed by the canonical `OperatorSnapshot`; navigation does not imply that a missing read-model field is available.

Workers show the existing attempt and pending-command projection. Models show only model identity, family and pool observed on attempts and label availability unknown. Log states that entries are unavailable because the snapshot has no log collection. Nullable Map and Needs You values retain their distinction between unavailable (`null`) and known empty (`[]`). Existing HTML escaping, evidence mode, resource/cost units and unknown states remain in force.
