/**
 * Utility for generating user-friendly error messages
 * Distinguishes between network, validation, and server errors
 */

export type ErrorType = "network" | "validation" | "server" | "unknown";

interface ParsedError {
  type: ErrorType;
  message: string;
  action: string;
}

/**
 * Parse an error and return a user-friendly message with suggested action
 */
export function parseError(error: unknown, context?: string): ParsedError {
  // Network errors (offline, DNS, timeout)
  if (error instanceof TypeError && error.message.includes("fetch")) {
    return {
      type: "network",
      message: "Unable to connect to the server",
      action: "Please check your internet connection and try again.",
    };
  }

  // AbortError (request cancelled)
  if (error instanceof DOMException && error.name === "AbortError") {
    return {
      type: "network",
      message: "Request was cancelled",
      action: "Please try again.",
    };
  }

  // Response errors with status codes
  if (error instanceof Response || (error && typeof error === "object" && "status" in error)) {
    const status = (error as { status: number }).status;

    if (status === 401) {
      return {
        type: "validation",
        message: "You need to be logged in",
        action: "Please sign in and try again.",
      };
    }

    if (status === 403) {
      return {
        type: "validation",
        message: "You don't have permission to do this",
        action: "Please contact an administrator if you believe this is an error.",
      };
    }

    if (status === 404) {
      return {
        type: "validation",
        message: context ? `${context} not found` : "The requested item was not found",
        action: "It may have been moved or deleted.",
      };
    }

    if (status === 409) {
      return {
        type: "validation",
        message: "This conflicts with existing data",
        action: "Please check for duplicates or refresh the page.",
      };
    }

    if (status === 422 || status === 400) {
      return {
        type: "validation",
        message: "Invalid data provided",
        action: "Please check your input and try again.",
      };
    }

    if (status >= 500) {
      return {
        type: "server",
        message: "The server encountered an error",
        action: "Please try again in a few moments. If the problem persists, contact support.",
      };
    }
  }

  // Error instances with messages
  if (error instanceof Error) {
    // Check for specific error patterns
    if (error.message.toLowerCase().includes("network")) {
      return {
        type: "network",
        message: "Network error occurred",
        action: "Please check your internet connection and try again.",
      };
    }

    if (error.message.toLowerCase().includes("timeout")) {
      return {
        type: "network",
        message: "The request took too long",
        action: "Please try again. If the problem persists, try refreshing the page.",
      };
    }

    // Return the error message if it's reasonably user-friendly
    if (error.message.length < 100 && !error.message.includes("undefined") && !error.message.includes("null")) {
      return {
        type: "unknown",
        message: error.message,
        action: "Please try again.",
      };
    }
  }

  // Default fallback
  return {
    type: "unknown",
    message: context ? `Failed to ${context.toLowerCase()}` : "Something went wrong",
    action: "Please try again. If the problem persists, refresh the page.",
  };
}

/**
 * Get a single user-friendly error string
 */
export function getErrorMessage(error: unknown, context?: string): string {
  const { message, action } = parseError(error, context);
  return `${message}. ${action}`;
}

/**
 * Get just the error message without the action
 */
export function getShortErrorMessage(error: unknown, context?: string): string {
  return parseError(error, context).message;
}

/**
 * Check if an error is likely a network connectivity issue
 */
export function isNetworkError(error: unknown): boolean {
  return parseError(error).type === "network";
}

/**
 * Check if an error is a validation/client error (4xx)
 */
export function isValidationError(error: unknown): boolean {
  return parseError(error).type === "validation";
}

/**
 * Check if an error is a server error (5xx)
 */
export function isServerError(error: unknown): boolean {
  return parseError(error).type === "server";
}
