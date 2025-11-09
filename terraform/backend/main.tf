provider "aws" {
    region = "ap-south-1"

}

resource "aws_s3_bucket" "example" {
  bucket = "taskops-backend-state-s3-bucket"

  lifecycle {
    prevent_destroy = false
  }
}

resource "aws_dynamodb_table" "basic-dynamodb-table" {
  name           = "taskops-backend-lock-table"
  billing_mode   = "PAY_PER_REQUEST"
  hash_key       = "LockID"
  

  attribute {
    name = "LockID"
    type = "S"
  }
}