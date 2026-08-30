from enum import StrEnum
from typing import Literal

from pydantic import BaseModel, ConfigDict

CONTRACT_VERSION = "careledger.record_extraction.v1"


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class FactType(StrEnum):
    DEMOGRAPHIC = "demographic"
    DIAGNOSIS = "diagnosis"
    PATHOLOGY = "pathology"
    IMAGING_FINDING = "imaging_finding"
    LABORATORY_RESULT = "laboratory_result"
    MEDICATION = "medication"
    ALLERGY = "allergy"
    PROCEDURE = "procedure"
    SYMPTOM = "symptom"
    VITAL = "vital"
    CLINICAL_PLAN = "clinical_plan"
    RECOMMENDATION = "recommendation"
    FOLLOW_UP = "follow_up"
    APPOINTMENT = "appointment"
    HISTORY = "history"
    OTHER = "other"


class EvidenceCategory(StrEnum):
    SOURCE_DOCUMENTED_FACT = "source_documented_fact"
    CLINICIAN_INTERPRETATION = "clinician_interpretation"
    UNCONFIRMED_RECOLLECTION = "unconfirmed_recollection"


class SourceQualifier(StrEnum):
    UNQUALIFIED = "unqualified"
    POSSIBLE = "possible"
    SUSPICIOUS = "suspicious"
    SUGGESTIVE = "suggestive"
    PROBABLE = "probable"
    LIKELY = "likely"
    FAVORED = "favored"
    REPORTED = "reported"
    OTHER = "other"


class DatePrecision(StrEnum):
    DAY = "day"
    MONTH = "month"
    YEAR = "year"
    UNKNOWN = "unknown"


class DateKind(StrEnum):
    COLLECTION = "collection"
    SPECIMEN = "specimen"
    PROCEDURE = "procedure"
    REPORT = "report"
    VISIT = "visit"
    COMMUNICATION = "communication"
    REFERENCE = "reference"
    UNKNOWN = "unknown"


class UncertaintyLevel(StrEnum):
    NONE = "none"
    MINOR = "minor"
    MATERIAL = "material"


class UncertaintyReason(StrEnum):
    ILLEGIBLE = "illegible"
    AMBIGUOUS_TERM = "ambiguous_term"
    AMBIGUOUS_DATE = "ambiguous_date"
    UNCERTAIN_ATTRIBUTION = "uncertain_attribution"
    MISSING_CONTEXT = "missing_context"
    CONFLICTING_TEXT = "conflicting_text"
    OTHER = "other"


class BoundingBox(StrictModel):
    x0: float
    y0: float
    x1: float
    y1: float


class Citation(StrictModel):
    page_number: int
    quote: str | None
    bbox: BoundingBox | None


class DateEvidence(StrictModel):
    text: str | None
    iso_date: str | None
    precision: DatePrecision
    kind: DateKind


class ExtractionUncertainty(StrictModel):
    level: UncertaintyLevel
    reasons: list[UncertaintyReason]
    note: str | None


class ModelClaim(StrictModel):
    candidate_ref: str
    fact_type: FactType
    statement: str
    plain_language: str
    evidence_category: EvidenceCategory
    source_qualifier: SourceQualifier
    source_qualifier_text: str | None
    event_date: DateEvidence
    uncertainty: ExtractionUncertainty
    citations: list[Citation]


class PageAssessment(StrictModel):
    page_number: int
    has_relevant_content: bool
    notes: str | None


class ExtractionPayload(StrictModel):
    contract_version: Literal["careledger.record_extraction.v1"]
    batch_token: str
    page_assessments: list[PageAssessment]
    claims: list[ModelClaim]
