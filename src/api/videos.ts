import { respondWithJSON } from "./json";
import { getBearerToken, validateJWT } from "../auth";
import { getVideo, updateVideo } from "../db/videos";
import { BadRequestError, NotFoundError, UserForbiddenError } from "./errors";
import { randomBytes } from "crypto";
import path from "path";

import { type ApiConfig } from "../config";
import type { BunRequest } from "bun";

export async function handlerUploadVideo(cfg: ApiConfig, req: BunRequest) {
  // Set upload limit of 1 GB
  const MAX_UPLOAD_SIZE = 1 << 30; // 1 GB = 1073741824 bytes

  // Extract videoID from URL path parameters and parse as UUID
  const { videoId } = req.params as { videoId?: string };
  if (!videoId) {
    throw new BadRequestError("Invalid video ID");
  }

  // Authenticate the user to get userID
  const token = getBearerToken(req.headers);
  const userID = validateJWT(token, cfg.jwtSecret);

  console.log("uploading video for video", videoId, "by user", userID);

  // Get the video metadata from the database
  const video = getVideo(cfg.db, videoId);
  if (!video) {
    throw new NotFoundError("Video not found");
  }

  // Check if the user is the video owner
  if (video.userID !== userID) {
    throw new UserForbiddenError("User is not authorized to upload video for this video");
  }

  // Parse the uploaded video file from the form data
  const formData = await req.formData();
  const videoFile = formData.get("video");
  if (!(videoFile instanceof File)) {
    throw new BadRequestError("Invalid file upload");
  }

  // Check that file size does not exceed upload limit
  if (videoFile.size > MAX_UPLOAD_SIZE) {
    throw new BadRequestError("File size exceeds 1GB limit");
  }

  // Validate the uploaded file to ensure it's an MP4 video
  if (videoFile.type !== "video/mp4") {
    throw new BadRequestError("Only MP4 video format is allowed");
  }

  // Generate random filename using 32 random bytes converted to hex
  const randomBuffer = randomBytes(32);
  const randomFileName = randomBuffer.toString("hex");
  const fileName = `${randomFileName}.mp4`;

  // Save the uploaded file to a temporary file on disk
  const tempFilePath = path.join("/tmp", fileName);
  
  try {
    // Write the file to temporary location
    await Bun.write(tempFilePath, videoFile);

    // Put the object into S3
    const s3File = cfg.s3Client.file(fileName);
    await s3File.write(Bun.file(tempFilePath), {
      type: "video/mp4"
    });

    // Update the VideoURL of the video record in the database with S3 URL
    // Note: Switch to CloudFront URL once S3_CF_DISTRO is properly configured
    const videoURL = `https://${cfg.s3Bucket}.s3.${cfg.s3Region}.amazonaws.com/${fileName}`;
    
    const updatedVideo = {
      ...video,
      videoURL,
    };

    // Update the video in the database
    updateVideo(cfg.db, updatedVideo);

    // Return the updated video metadata
    return respondWithJSON(200, updatedVideo);
  } finally {
    // Remove the temporary file
    try {
      const fs = await import("fs/promises");
      await fs.unlink(tempFilePath);
    } catch (error) {
      console.warn("Failed to clean up temporary file:", error);
    }
  }
}
