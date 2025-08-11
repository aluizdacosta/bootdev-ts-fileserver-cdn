import { getBearerToken, validateJWT } from "../auth";
import { respondWithJSON } from "./json";
import { getVideo, updateVideo } from "../db/videos";
import type { ApiConfig } from "../config";
import type { BunRequest } from "bun";
import { BadRequestError, NotFoundError, UserForbiddenError } from "./errors";

type Thumbnail = {
  data: ArrayBuffer;
  mediaType: string;
};

const videoThumbnails: Map<string, Thumbnail> = new Map();

export async function handlerGetThumbnail(cfg: ApiConfig, req: BunRequest) {
  const { videoId } = req.params as { videoId?: string };
  if (!videoId) {
    throw new BadRequestError("Invalid video ID");
  }

  const video = getVideo(cfg.db, videoId);
  if (!video) {
    throw new NotFoundError("Couldn't find video");
  }

  const thumbnail = videoThumbnails.get(videoId);
  if (!thumbnail) {
    throw new NotFoundError("Thumbnail not found");
  }

  return new Response(thumbnail.data, {
    headers: {
      "Content-Type": thumbnail.mediaType,
      "Cache-Control": "no-store",
    },
  });
}

export async function handlerUploadThumbnail(cfg: ApiConfig, req: BunRequest) {
  const { videoId } = req.params as { videoId?: string };
  if (!videoId) {
    throw new BadRequestError("Invalid video ID");
  }

  const token = getBearerToken(req.headers);
  const userID = validateJWT(token, cfg.jwtSecret);

  console.log("uploading thumbnail for video", videoId, "by user", userID);

  // Parse the form data
  const formData = await req.formData();
  
  // Get the image data from the form
  const thumbnail = formData.get("thumbnail");
  if (!(thumbnail instanceof File)) {
    throw new BadRequestError("Invalid file upload");
  }

  // Check file size (10MB max)
  const MAX_UPLOAD_SIZE = 10 << 20; // 10 * 1024 * 1024 = 10MB
  if (thumbnail.size > MAX_UPLOAD_SIZE) {
    throw new BadRequestError("File size exceeds 10MB limit");
  }

  // Get the media type
  const mediaType = thumbnail.type;
  
  // Read the image data into ArrayBuffer
  const data = await thumbnail.arrayBuffer();

  // Get the video's metadata from the database
  const video = getVideo(cfg.db, videoId);
  if (!video) {
    throw new NotFoundError("Video not found");
  }

  // Check if the authenticated user is the video owner
  if (video.userID !== userID) {
    throw new UserForbiddenError("User is not authorized to upload thumbnail for this video");
  }

  // Save the thumbnail to the global map
  videoThumbnails.set(videoId, {
    data,
    mediaType,
  });

  // Generate the thumbnail URL
  const thumbnailURL = `http://localhost:${cfg.port}/api/thumbnails/${videoId}`;

  // Update the video metadata with the new thumbnail URL
  const updatedVideo = {
    ...video,
    thumbnailURL,
  };

  // Update the video in the database
  updateVideo(cfg.db, updatedVideo);

  // Return the updated video metadata
  return respondWithJSON(200, updatedVideo);
}
