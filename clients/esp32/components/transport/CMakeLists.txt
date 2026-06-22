file(GLOB PROTO_GENERATED_SRCS "generated/proto/moumantai/v1/*.pb.c")
file(GLOB PROTO_GENERATED_GOOGLE "generated/proto/google/protobuf/*.pb.c")

idf_component_register(
    # Transport sources:
    #   transport.c     — WS lifecycle + dispatch (subprotocol moumantai.v1.proto)
    #   binary_frame.c  — audio binary frame envelope (typed AudioChunkHeader)
    #   proto_encode.c  — outbound ClientMessage encoders
    #   proto_decode.c  — inbound ServerMessage dispatcher (cJSON only inside
    #                     the google.protobuf.Struct face-data helper)
    SRCS "transport.c" "binary_frame.c" "proto_encode.c" "proto_decode.c"
         ${PROTO_GENERATED_SRCS} ${PROTO_GENERATED_GOOGLE}
    INCLUDE_DIRS "include" "generated/proto"
    REQUIRES esp_event json nanopb
    PRIV_REQUIRES esp_websocket_client log config_store
)
