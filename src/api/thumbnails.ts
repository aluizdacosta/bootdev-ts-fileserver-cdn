import { getBearerToken, validateJWT } from "../auth";
import { respondWithJSON } from "./json";
import { getVideo, updateVideo } from "../db/videos";
import type { ApiConfig } from "../config";
import type { BunRequest } from "bun";
import { BadRequestError, NotFoundError, UserForbiddenError } from "./errors";
import path from "path";
import { randomBytes } from "crypto";

function getFileExtension(mediaType: string): string {
  const mimeToExt: Record<string, string> = {
    "image/jpeg": "jpg",
    "image/jpg": "jpg", 
    "image/png": "png",
    "image/gif": "gif",
    "image/webp": "webp",
    "image/svg+xml": "svg"
  };
  
  return mimeToExt[mediaType] || "jpg";
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
  
  // Validate media type - only allow JPEG and PNG
  if (mediaType !== "image/jpeg" && mediaType !== "image/png") {
    throw new BadRequestError("Only JPEG and PNG image formats are allowed for thumbnails");
  }
  
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

  // Determine file extension from media type
  const fileExtension = getFileExtension(mediaType);
  
  // Generate random filename using 32 random bytes converted to base64url
  const randomBuffer = randomBytes(32);
  const randomFileName = randomBuffer.toString("base64url");
  const fileName = `${randomFileName}.${fileExtension}`;
  const filePath = path.join(cfg.assetsRoot, fileName);
  
  // Save the file to disk using Bun.write
  await Bun.write(filePath, data);
  
  // Create thumbnail URL pointing to the assets endpoint
  const thumbnailURL = `http://localhost:${cfg.port}/assets/${fileName}`;

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
