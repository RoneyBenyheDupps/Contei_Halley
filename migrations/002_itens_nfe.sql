CREATE TABLE contei.ItensNfeExtraidos (
  xmlOccurrenceId bigint NOT NULL CONSTRAINT PK_ItensNfeExtraidos PRIMARY KEY
    CONSTRAINT FK_ItensNfeExtraidos_Ocorrencia REFERENCES contei.OcorrenciaDocumental(id),
  itemsJson nvarchar(max) NOT NULL CONSTRAINT CK_ItensNfeExtraidos_Json CHECK (ISJSON(itemsJson) = 1 AND LEFT(LTRIM(itemsJson), 1) = '['),
  extractedAt datetimeoffset(3) NOT NULL
);

ALTER TABLE contei.FalhaIntegracao ADD xmlOccurrenceId bigint NULL;
ALTER TABLE contei.FalhaIntegracao ADD CONSTRAINT FK_Falha_XmlOccurrence FOREIGN KEY (xmlOccurrenceId) REFERENCES contei.OcorrenciaDocumental(id);
EXEC('ALTER TABLE contei.FalhaIntegracao ADD CONSTRAINT CK_Falha_ItemExtractionVersion CHECK (kind <> ''ITEM_EXTRACTION'' OR (documentoId IS NOT NULL AND xmlOccurrenceId IS NOT NULL))');
EXEC('CREATE UNIQUE INDEX UX_Falha_ItemExtraction_Open ON contei.FalhaIntegracao (xmlOccurrenceId)
  WHERE kind = ''ITEM_EXTRACTION'' AND state = ''OPEN''');

GRANT SELECT, INSERT ON OBJECT::contei.ItensNfeExtraidos TO contei_runtime;
DENY UPDATE, DELETE ON OBJECT::contei.ItensNfeExtraidos TO contei_runtime;
