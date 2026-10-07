"""Optional private supplier; importing this module does not import LightRAG."""
from .adapter import LightRAGSupplier, SupplierError, CAPABILITIES, QUERY_FIELDS
from .artifacts import FileArtifacts, MemoryArtifacts
from .projection import build_projection

__all__ = ["LightRAGSupplier", "SupplierError", "CAPABILITIES", "QUERY_FIELDS",
           "FileArtifacts", "MemoryArtifacts", "build_projection"]
