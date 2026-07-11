"""
Utility functions for Perplexity AI library.

This module provides helper functions for retry logic and other common operations.
"""

import time
import random
from functools import wraps
from typing import Any, Callable, Optional, Tuple, Type

from .config import (
    RETRY_MAX_ATTEMPTS,
    RETRY_BACKOFF_FACTOR,
    RATE_LIMIT_MIN_DELAY,
    RATE_LIMIT_MAX_DELAY,
)
from .logger import get_logger

logger = get_logger("utils")


def retry_with_backoff(
    max_attempts: int = RETRY_MAX_ATTEMPTS,
    backoff_factor: float = RETRY_BACKOFF_FACTOR,
    exceptions: Tuple[Type[Exception], ...] = (Exception,),
    on_retry: Optional[Callable[[int, Exception], None]] = None,
) -> Callable:
    """
    Decorator that retries a function with exponential backoff.

    Args:
        max_attempts: Maximum number of retry attempts
        backoff_factor: Multiplier for wait time between retries
        exceptions: Tuple of exception types to catch
        on_retry: Optional callback function called on each retry

    Returns:
        Decorated function with retry logic

    Example:
        >>> @retry_with_backoff(max_attempts=3)
        ... def fetch_data():
        ...     return api.get("/data")
    """

    def decorator(func: Callable) -> Callable:
        @wraps(func)
        def wrapper(*args: Any, **kwargs: Any) -> Any:
            attempt = 0
            while attempt < max_attempts:
                try:
                    return func(*args, **kwargs)
                except exceptions as e:
                    attempt += 1
                    if attempt >= max_attempts:
                        logger.error(f"Failed after {max_attempts} attempts: {e}")
                        raise

                    wait_time = backoff_factor**attempt + random.uniform(0, 1)
                    logger.warning(
                        f"Attempt {attempt}/{max_attempts} failed: {e}. "
                        f"Retrying in {wait_time:.2f}s..."
                    )

                    if on_retry:
                        on_retry(attempt, e)

                    time.sleep(wait_time)

            raise Exception(f"Failed after {max_attempts} attempts")

        return wrapper

    return decorator


def rate_limit(
    min_delay: float = RATE_LIMIT_MIN_DELAY,
    max_delay: float = RATE_LIMIT_MAX_DELAY,
) -> Callable:
    """
    Decorator that rate limits function calls with random delay.

    Args:
        min_delay: Minimum delay in seconds
        max_delay: Maximum delay in seconds

    Returns:
        Decorated function with rate limiting

    Example:
        >>> @rate_limit(min_delay=1.0, max_delay=3.0)
        ... def make_request():
        ...     return api.get("/endpoint")
    """

    def decorator(func: Callable) -> Callable:
        last_call = [0.0]  # Mutable container to store across calls

        @wraps(func)
        def wrapper(*args: Any, **kwargs: Any) -> Any:
            delay = random.uniform(min_delay, max_delay)
            elapsed = time.time() - last_call[0]

            if elapsed < delay:
                sleep_time = delay - elapsed
                logger.debug(f"Rate limiting: waiting {sleep_time:.2f}s")
                time.sleep(sleep_time)

            last_call[0] = time.time()
            return func(*args, **kwargs)

        return wrapper

    return decorator


def parse_nested_json_response(content_json: dict) -> dict:
    """
    Parse nested JSON response from Perplexity API.

    Extracts answer and chunks from the nested 'text' field structure:
    text (JSON string) -> list of steps -> FINAL step -> answer (JSON string)

    Args:
        content_json: Response JSON from API

    Returns:
        Enriched response with extracted answer and chunks

    Example:
        >>> response = parse_nested_json_response(api_response)
        >>> print(response['answer'])
    """
    import json

    if "text" in content_json and content_json["text"]:
        try:
            text_parsed = json.loads(content_json["text"])

            if isinstance(text_parsed, list):
                for step in text_parsed:
                    if step.get("step_type") == "FINAL":
                        final_content = step.get("content", {})

                        if "answer" in final_content:
                            try:
                                answer_data = json.loads(final_content["answer"])
                                content_json["answer"] = answer_data.get("answer", "")
                                content_json["chunks"] = answer_data.get("chunks", [])
                            except (json.JSONDecodeError, TypeError):
                                pass
                        break

            content_json["text"] = text_parsed
        except (json.JSONDecodeError, TypeError, KeyError):
            pass

    return content_json
