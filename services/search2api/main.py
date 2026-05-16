from typing import Optional
import traceback

from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware

from app.core.config import settings
from app.providers.search_provider import SearchProvider

app = FastAPI(
    title="Search-2api",
    version="7.1.0-fusionsearch",
    description="OpenAI-compatible adapter for search.sh used by FusionSearch.",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

search_provider = SearchProvider()


async def verify_api_key(authorization: Optional[str] = Header(None)):
    if settings.API_MASTER_KEY:
        if authorization is None:
            raise HTTPException(status_code=401, detail="Unauthorized: Missing Authorization header.")
        try:
            scheme, token = authorization.split()
            if scheme.lower() != "bearer" or token != settings.API_MASTER_KEY:
                raise ValueError("Invalid scheme or token")
        except ValueError:
            raise HTTPException(status_code=403, detail="Forbidden: Invalid API Key or authentication scheme.")


@app.post("/v1/chat/completions", dependencies=[Depends(verify_api_key)])
async def chat_completions(request: Request):
    try:
        request_data = await request.json()
        return await search_provider.handle_chat_completion(request_data)
    except HTTPException:
        raise
    except Exception as exc:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Search-2api route error: {exc}") from exc


@app.get("/v1/models")
async def list_models():
    return await search_provider.handle_list_models()


@app.get("/")
def root():
    return {"message": f"Welcome to {app.title}", "version": app.version}
