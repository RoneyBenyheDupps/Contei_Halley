CREATE TABLE contei.EmpresaFiscal (
  id tinyint NOT NULL CONSTRAINT PK_EmpresaFiscal PRIMARY KEY CONSTRAINT CK_EmpresaFiscal_One CHECK (id = 1),
  halleyCompanyId nvarchar(100) NOT NULL CONSTRAINT UQ_EmpresaFiscal_Halley UNIQUE,
  cnpj char(14) NOT NULL CONSTRAINT UQ_EmpresaFiscal_Cnpj UNIQUE,
  status varchar(8) NOT NULL CONSTRAINT CK_EmpresaFiscal_Status CHECK (status IN ('INACTIVE','ACTIVE')),
  activatedAt datetimeoffset(3) NULL,
  qiveConnectionRef nvarchar(200) NOT NULL,
  qiveValidatedAt datetimeoffset(3) NULL,
  qiveValidationEvidenceRef nvarchar(500) NULL,
  certificateEvidenceRef nvarchar(500) NULL,
  completeCaptureEvidenceRef nvarchar(500) NULL,
  CONSTRAINT CK_EmpresaFiscal_ActiveProof CHECK (status = 'INACTIVE' OR (activatedAt IS NOT NULL AND qiveValidatedAt IS NOT NULL AND qiveValidationEvidenceRef IS NOT NULL AND certificateEvidenceRef IS NOT NULL AND completeCaptureEvidenceRef IS NOT NULL))
);

CREATE TABLE contei.DocumentoEntrada (
  id bigint IDENTITY(1,1) NOT NULL CONSTRAINT PK_DocumentoEntrada PRIMARY KEY,
  empresaId tinyint NOT NULL CONSTRAINT FK_Documento_Empresa REFERENCES contei.EmpresaFiscal(id),
  accessKey char(44) NOT NULL,
  qiveCreatedAt datetimeoffset(3) NULL,
  firstSeenAt datetimeoffset(3) NOT NULL DEFAULT TODATETIMEOFFSET(SYSUTCDATETIME(), '+00:00'),
  lastCheckedAt datetimeoffset(3) NULL,
  scope varchar(11) NOT NULL DEFAULT 'UNCONFIRMED' CONSTRAINT CK_Documento_Scope CHECK (scope IN ('UNCONFIRMED','IN','OUT')),
  captureState varchar(20) NOT NULL DEFAULT 'PENDING_METADATA' CONSTRAINT CK_Documento_Capture CHECK (captureState IN ('PENDING_METADATA','AWAITING_XML','XML_VERIFIED','TECHNICAL_BLOCKED')),
  qiveStatusRaw nvarchar(100) NULL,
  canceled bit NOT NULL DEFAULT 0,
  triageEnteredAt datetimeoffset(3) NULL,
  reviewVersion int NOT NULL DEFAULT 0,
  documentRevision int NOT NULL DEFAULT 0,
  lastDocumentChangeAt datetimeoffset(3) NULL,
  number nvarchar(30) NULL,
  emitterName nvarchar(300) NULL,
  emitterCnpj char(14) NULL,
  receiverName nvarchar(300) NULL,
  receiverCnpj char(14) NULL,
  totalAmount decimal(15,2) NULL,
  issuedAt datetimeoffset(3) NULL,
  origin nvarchar(100) NULL,
  firstXmlOccurrenceId bigint NULL,
  latestValidXmlOccurrenceId bigint NULL,
  CONSTRAINT UQ_Documento_Empresa_Chave UNIQUE (empresaId, accessKey),
  CONSTRAINT CK_Documento_Revision CHECK (reviewVersion >= 0 AND documentRevision >= 0),
  CONSTRAINT CK_Documento_TriageXml CHECK (triageEnteredAt IS NULL OR captureState = 'XML_VERIFIED')
);
CREATE INDEX IX_Documento_Entrada ON contei.DocumentoEntrada (empresaId, qiveCreatedAt, accessKey);
CREATE INDEX IX_Documento_Revisit ON contei.DocumentoEntrada (empresaId, lastCheckedAt) INCLUDE (accessKey);

CREATE TABLE contei.OcorrenciaDocumental (
  id bigint IDENTITY(1,1) NOT NULL CONSTRAINT PK_Ocorrencia PRIMARY KEY,
  documentoId bigint NOT NULL CONSTRAINT FK_Ocorrencia_Documento REFERENCES contei.DocumentoEntrada(id),
  kind varchar(8) NOT NULL CONSTRAINT CK_Ocorrencia_Kind CHECK (kind IN ('SNAPSHOT','XML','EVENT')),
  sourceName varchar(4) NOT NULL DEFAULT 'QIVE' CONSTRAINT CK_Ocorrencia_Source CHECK (sourceName = 'QIVE'),
  sourceSection varchar(14) NOT NULL CONSTRAINT CK_Ocorrencia_Section CHECK (sourceSection IN ('NFE','EVENTS','MANIFESTATIONS')),
  sourceRef nvarchar(200) NULL,
  eventType nvarchar(100) NULL,
  eventAt datetimeoffset(3) NULL,
  observedAt datetimeoffset(3) NOT NULL DEFAULT TODATETIMEOFFSET(SYSUTCDATETIME(), '+00:00'),
  qiveCreatedAt datetimeoffset(3) NULL,
  origin nvarchar(100) NULL,
  rawPayload varbinary(max) NOT NULL,
  contentType varchar(32) NOT NULL CONSTRAINT CK_Ocorrencia_ContentType CHECK (contentType IN ('application/json','application/xml')),
  sha256 binary(32) NOT NULL,
  collisionOrdinal int NOT NULL DEFAULT 0 CONSTRAINT CK_Ocorrencia_Ordinal CHECK (collisionOrdinal >= 0),
  eventXmlBytes varbinary(max) NULL,
  eventXmlSha256 binary(32) NULL,
  isValidXml bit NULL,
  validationErrorCode varchar(80) NULL,
  CONSTRAINT CK_Ocorrencia_SectionKind CHECK ((kind = 'EVENT' AND sourceSection IN ('EVENTS','MANIFESTATIONS')) OR (kind IN ('SNAPSHOT','XML') AND sourceSection = 'NFE')),
  CONSTRAINT UQ_Ocorrencia_Payload UNIQUE (documentoId, kind, sourceSection, sha256, collisionOrdinal)
);
CREATE INDEX IX_Ocorrencia_Documento_Observada ON contei.OcorrenciaDocumental (documentoId, observedAt, id);
ALTER TABLE contei.DocumentoEntrada ADD CONSTRAINT FK_Documento_FirstXml FOREIGN KEY (firstXmlOccurrenceId) REFERENCES contei.OcorrenciaDocumental(id);
ALTER TABLE contei.DocumentoEntrada ADD CONSTRAINT FK_Documento_LatestXml FOREIGN KEY (latestValidXmlOccurrenceId) REFERENCES contei.OcorrenciaDocumental(id);

CREATE TABLE contei.DecisaoTriagem (
  id bigint IDENTITY(1,1) NOT NULL CONSTRAINT PK_Decisao PRIMARY KEY,
  documentoId bigint NOT NULL CONSTRAINT FK_Decisao_Documento REFERENCES contei.DocumentoEntrada(id),
  sequence int NOT NULL CONSTRAINT CK_Decisao_Sequence CHECK (sequence >= 1),
  outcome varchar(18) NOT NULL CONSTRAINT CK_Decisao_Outcome CHECK (outcome IN ('NO_ACTION','TREATMENT_PENDING')),
  reasonCode varchar(48) NOT NULL,
  observation nvarchar(max) NULL,
  actorId nvarchar(200) NOT NULL,
  actorRole nvarchar(100) NOT NULL,
  decidedAt datetimeoffset(3) NOT NULL DEFAULT TODATETIMEOFFSET(SYSUTCDATETIME(), '+00:00'),
  basisReviewVersion int NOT NULL,
  basisDocumentRevision int NOT NULL,
  evidenceSnapshot nvarchar(max) NOT NULL,
  idempotencyKey uniqueidentifier NOT NULL,
  requestHash binary(32) NOT NULL,
  CONSTRAINT UQ_Decisao_Sequence UNIQUE (documentoId, sequence),
  CONSTRAINT UQ_Decisao_Idempotency UNIQUE (documentoId, idempotencyKey)
);
CREATE INDEX IX_Decisao_Latest ON contei.DecisaoTriagem (documentoId, sequence DESC);

CREATE TABLE contei.FalhaIntegracao (
  id bigint IDENTITY(1,1) NOT NULL CONSTRAINT PK_Falha PRIMARY KEY,
  documentoId bigint NULL CONSTRAINT FK_Falha_Documento REFERENCES contei.DocumentoEntrada(id),
  kind varchar(32) NOT NULL,
  firstAt datetimeoffset(3) NOT NULL,
  lastAt datetimeoffset(3) NOT NULL,
  attempts int NOT NULL DEFAULT 1,
  nextRetryAt datetimeoffset(3) NULL,
  state varchar(8) NOT NULL CONSTRAINT CK_Falha_State CHECK (state IN ('OPEN','RESOLVED')),
  resolvedAt datetimeoffset(3) NULL,
  safeDetail nvarchar(500) NULL
);

CREATE TABLE contei.SyncCheckpoint (
  empresaId tinyint NOT NULL CONSTRAINT PK_SyncCheckpoint PRIMARY KEY CONSTRAINT FK_Sync_Empresa REFERENCES contei.EmpresaFiscal(id),
  newRecordsCoveredUntil datetimeoffset(3) NULL,
  lastSuccessfulNewPollAt datetimeoffset(3) NULL,
  lastSuccessfulRevisitAt datetimeoffset(3) NULL
);

CREATE ROLE contei_runtime;
GRANT SELECT, INSERT, UPDATE ON OBJECT::contei.EmpresaFiscal TO contei_runtime;
GRANT SELECT, INSERT, UPDATE ON OBJECT::contei.DocumentoEntrada TO contei_runtime;
GRANT SELECT, INSERT, UPDATE ON OBJECT::contei.SyncCheckpoint TO contei_runtime;
GRANT SELECT, INSERT, UPDATE ON OBJECT::contei.FalhaIntegracao TO contei_runtime;
GRANT SELECT, INSERT ON OBJECT::contei.OcorrenciaDocumental TO contei_runtime;
GRANT SELECT, INSERT ON OBJECT::contei.DecisaoTriagem TO contei_runtime;
DENY UPDATE, DELETE ON OBJECT::contei.OcorrenciaDocumental TO contei_runtime;
DENY UPDATE, DELETE ON OBJECT::contei.DecisaoTriagem TO contei_runtime;
