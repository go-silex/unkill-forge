CREATE TABLE artefact_tags (
  artefact_id TEXT NOT NULL REFERENCES artefacts(id) ON DELETE CASCADE,
  tag TEXT NOT NULL,
  PRIMARY KEY (artefact_id, tag)
);

CREATE INDEX artefact_tags_tag_artefact ON artefact_tags(tag, artefact_id);
